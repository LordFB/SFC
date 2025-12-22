import { Plugin } from 'vite';
import { transformSFC } from './transformer';
import fs from 'fs';
import path from 'path';
import { debounce } from './utils/debounce';
import esbuild from 'esbuild';
import * as parser from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';
import * as t from '@babel/types';
import ts from 'typescript';

export default function sfcPlugin(): Plugin {
  const virtualModuleId = 'virtual:routes';
  const resolvedVirtualId = '\0' + virtualModuleId;

  function getRoutes() {
    const componentsDir = path.resolve(process.cwd(), 'components');
    const routes = [];

    function scan(dir, prefix = '') {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          scan(fullPath, prefix + '/' + file);
        } else if (file.endsWith('.sfc')) {
          const content = fs.readFileSync(fullPath, 'utf8');
          const routeMatch = content.match(/<route([^>]*)>([\s\S]*?)<\/route>/i) || content.match(/<route([^>]*)\s*\/?>/i);
          if (routeMatch) {
            const attrString = routeMatch[1] || '';
            const attrs: Record<string,string> = {};
            for (const m of attrString.matchAll(/([a-zA-Z0-9-:]+)\s*=\s*"([^"]*)"/g)) {
              attrs[m[1]] = m[2];
            }
            // Support redirect routes
            if (attrs.redirect) {
              attrs.isRedirect = 'true';
              attrs.redirectMethod = attrs.method || '302';
              // For redirect, path is required, no tag/component needed
              let p = attrs.path;
              if (!p || p === '/') {
                const componentName = file.replace('.sfc', '').toLowerCase();
                if (prefix === '' && componentName === 'home') {
                  p = '/';
                } else {
                  p = prefix + '/' + componentName;
                }
              }
              attrs.path = p;
              const paramNames: string[] = [];
              if (p) {
                const matches = p.match(/:([a-zA-Z_][a-zA-Z0-9_]*)/g);
                if (matches) {
                  paramNames.push(...matches.map(m => m.slice(1)));
                }
              }
              routes.push({ ...attrs, paramNames });
            } else {
              // extract tag from script
              const scriptMatch = content.match(/<script[\s\S]*?>([\s\S]*?)<\/script>/i);
              if (scriptMatch) {
                const script = scriptMatch[1];
                // Match both object syntax (tag: 'name') and class syntax (static tag = 'name')
                const tagMatch = script.match(/(?:static\s+)?tag\s*[=:]\s*['"`]([^'"`]+)['"`]/);
                if (tagMatch) {
                  attrs.tag = tagMatch[1];
                }
              }
              let p = attrs.path;
              const componentName = file.replace('.sfc', '').toLowerCase();
              if (!p || p === '/') {
                if (prefix === '' && componentName === 'home') {
                  p = '/';
                } else {
                  p = prefix + '/' + componentName;
                }
              }
              attrs.path = p;
              const paramNames: string[] = [];
              if (p) {
                const matches = p.match(/:([a-zA-Z_][a-zA-Z0-9_]*)/g);
                if (matches) {
                  paramNames.push(...matches.map(m => m.slice(1)));
                }
              }
              const component = path.relative(componentsDir, fullPath).replace('.sfc', '').replace(/\\/g, '/');
              // Add filePath for lazy loading - relative to project root
              const relativeFilePath = '../' + path.relative(process.cwd(), fullPath).replace(/\\/g, '/');
              // if tag wasn't inferred, mark as handler-only so client router can ignore it
              if (!attrs.tag) attrs.handlerOnly = 'true';
              routes.push({ ...attrs, paramNames, component, filePath: relativeFilePath });
            }
          }
        }
      }
    }

    scan(componentsDir);
    return routes;
  }

  return {
    name: 'vite-plugin-sfc',
    enforce: 'pre',

    // Try to guide Vite/Rollup to produce a single JS bundle by inlining dynamic imports
    // and preventing manual chunking where possible. This is a best-effort change; the
    // build may still split depending on user config and dependencies.
    config() {
      return {
        build: {
          rollupOptions: {
            // allow Rollup to inline dynamic imports where safe
            inlineDynamicImports: true,
            output: {
              // unset manualChunks to reduce split-chunk heuristics
              manualChunks: undefined
            }
          }
        }
      };
    },

    // simple in-memory cache: id -> { mtime, code }
    _sfcCache: new Map(),

    configureServer(server) {
      if (server._sfcMiddlewaresAdded) return;
      server._sfcMiddlewaresAdded = true;

      // route manifest cache and mtime
      let routesCache: ReturnType<typeof getRoutes> | null = null;
      let routesCacheMtime: number | null = null;

      async function buildRoutesCache() {
        const r = getRoutes();
        routesCache = r;
        routesCacheMtime = Date.now();
        return r;
      }

      // initialize cache
      buildRoutesCache();

      // debounced invalidation to reduce thrash
      const invalidate = debounce(async () => {
        await buildRoutesCache();
        try { server.ws.send({ type: 'full-reload' }); } catch (e) {}
      }, 120);

      // ensure watcher watches components dir
      try {
        server.watcher.add(path.resolve(process.cwd(), 'components'));
        server.watcher.on('add', invalidate);
        server.watcher.on('change', invalidate);
        server.watcher.on('unlink', invalidate);
      } catch (e) {
        // watcher may not be available in some contexts
      }

      // helper: match a route pattern like /users/:id against a request pathname
      function pathMatches(routePath: string, reqPath: string) {
        if (!routePath) return false;
        // normalize: remove trailing slash unless root
        const normRoute = routePath === '/' ? '/' : routePath.replace(/\/$/, '');
        const normReq = reqPath === '/' ? '/' : reqPath.replace(/\/$/, '');
        const parts = normRoute.split('/').filter(Boolean);
        const reqParts = normReq.split('/').filter(Boolean);
        if (parts.length !== reqParts.length) return false;
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          if (p.startsWith(':')) continue;
          if (p !== reqParts[i]) return false;
        }
        return true;
      }
      // Middleware: single handler consults the live routes cache to respond to POSTs
      server.middlewares.use(async (req, res, next) => {
        try {
          const routes = routesCache ?? (await buildRoutesCache());
          const reqUrl = req.url || '';
          let pathname = '';
          try { pathname = (new URL(reqUrl, 'http://localhost')).pathname; } catch (e) { pathname = reqUrl.split('?')[0] || reqUrl; }
          if (req.method !== 'POST') return next();

          // find matching route(s)
          for (const route of routes) {
            const methods = route.methods ? String(route.methods).split(',').map((m: string) => m.trim()) : ['GET'];
            if (!methods.includes('POST')) continue;
            if (!pathMatches(route.path, pathname)) continue;

            // Collect body
            let body = '';
            for await (const chunk of req) { body += chunk; }

            const ct = (req.headers['content-type'] || '').split(';')[0].trim();
            let parsedBody: any = {};
            if (!body) parsedBody = {};
            else if (ct === 'application/json' || ct === 'application/vnd.api+json' || ct === '') {
              try { parsedBody = JSON.parse(body); } catch (err) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON body' })); return; }
            } else if (ct === 'application/x-www-form-urlencoded') {
              parsedBody = Object.fromEntries(new URLSearchParams(body));
            } else {
              parsedBody = body;
            }

            const scriptPath = path.resolve(process.cwd(), 'components', route.component + '.sfc');
            const scriptId = scriptPath + '?sfc-script';
            let mod: any = null;
            try {
              const sfcRaw = fs.readFileSync(scriptPath, 'utf8');
              const m = sfcRaw.match(/<script[\s\S]*?>([\s\S]*?)<\/script>/i);
              const scriptText = m ? m[1] : '';
              const hasPostHandler = /postHandler\s*[:=\(]/.test(scriptText) || /\bpostHandler\s*\(/.test(scriptText);
              if (hasPostHandler) {
                mod = await server.ssrLoadModule(scriptId);
              }
            } catch (e) {
              try { mod = await server.ssrLoadModule(scriptId); } catch (ee) { mod = null; }
            }

            let postHandler: any = null;
            if (mod) {
              if (mod.default) {
                const def = mod.default;
                if (typeof def === 'function') {
                  try { const inst = new def(); if (typeof inst.postHandler === 'function') postHandler = inst.postHandler.bind(inst); } catch (e) { if (typeof def === 'function') postHandler = def; }
                  if (!postHandler && typeof def.postHandler === 'function') postHandler = def.postHandler.bind(def);
                } else if (typeof def === 'object') {
                  if (typeof def.postHandler === 'function') postHandler = def.postHandler.bind(def);
                }
              }
              if (!postHandler && typeof mod.postHandler === 'function') postHandler = mod.postHandler.bind(mod);
            }

            if (postHandler) {
              try {
                const out = await postHandler(parsedBody, req, res);
                if (res.writableEnded) return;
                if (out === undefined || out === null) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: `POST handled for ${route.path}` })); return; }
                const status = typeof out.status === 'number' ? out.status : 200;
                const headers = out.headers || { 'Content-Type': 'application/json' };
                let bodyOut = out.body;
                if (headers['Content-Type'] && headers['Content-Type'].includes('application/json')) bodyOut = typeof bodyOut === 'string' ? bodyOut : JSON.stringify(bodyOut);
                res.writeHead(status, headers);
                res.end(bodyOut);
                return;
              } catch (err) { console.error('postHandler error', err); if (!res.writableEnded) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Handler exception' })); } return; }
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ message: `POST handled for ${route.path}`, body: parsedBody }));
              return;
            }
          }
        } catch (e) {
          // fallback
        }
        next();
      });
    },

    resolveId(id) {
      if (id === virtualModuleId) return resolvedVirtualId;
      return null;
    },

    async load(id) {
      if (id === resolvedVirtualId) {
        const routes = getRoutes();
        return `export const routes = ${JSON.stringify(routes)}`;
      }

      // handle virtual sfc script requests: path.sfc?sfc-script
      if (id.endsWith('?sfc-script')) {
        const real = id.slice(0, -'?sfc-script'.length);
        // id may be absolute or relative; try to resolve
        let file = real;
        if (!fs.existsSync(file)) {
          file = path.resolve(process.cwd(), real);
        }
        if (!fs.existsSync(file)) return null;
        const src = fs.readFileSync(file, 'utf8');
        // naive extraction of <script>...</script>
        const m = src.match(/<script[\s\S]*?>([\s\S]*?)<\/script>/i);
        const scriptContent = m ? m[1] : '';
        // preprocess decorators (@click, @input, @change, @debounce, @throttle)
        function astPreprocessDecorators(src: string) {
          // replace @decorator(args) occurrences with a comment marker for AST
          const replaced = src.replace(/@([A-Za-z_$][\w$]*)(\s*\(([^)]*)\))?\s*/g, (m, name, _parens, args) => {
            const enc = args ? encodeURIComponent(args) : '';
            return `/*__sfc_decorator:${name}:${enc}*/`;
          });

          // Quick regex fallback for anonymous `export default class` with simple decorators
          // This covers the common case where a default exported anonymous class has method decorators like `@click('.btn') onClick(...) {}`
          try {
            if (/export\s+default\s+class\b/.test(src)) {
              // find decorator+method occurrences
              const methodRe = /@([A-Za-z_$][\w$]*)\s*(?:\s*\(\s*(?:(['"`])([^\2]*?)\2\s*)?\)\s*)?\s*([A-Za-z_$][\w$]*)\s*\(/g;
              let m2;
              const assigns: string[] = [];
              while ((m2 = methodRe.exec(src)) !== null) {
                const decName = m2[1];
                const arg = m2[3] || '';
                const methodName = m2[4];
                assigns.push(`__SFC_CLS__.prototype.${methodName}.__sfc_decorators = [{type:'${decName}', args:[${arg ? `'${arg}'` : ''}]}];`);
              }
              if (assigns.length) {
                // replace first `export default class` with const wrapper
                const replacedClass = src.replace(/export\s+default\s+class/, 'const __SFC_CLS__ = class');
                const final = replacedClass + '\nexport default __SFC_CLS__;' + '\n' + assigns.join('\n');
                return final;
              }
            }
          } catch (e) {
            // ignore fallback errors and continue to AST path
          }

          try {
              // try parsing with decorators support first (for class decorators)
              let astWithDecorators: t.File | null = null;
              try {
                astWithDecorators = parser.parse(src, { sourceType: 'module', plugins: ['typescript', ['decorators', { legacy: true }], 'classProperties'] }) as any;
              } catch (e) {
                astWithDecorators = null;
              }

              if (astWithDecorators) {
                // handle class method decorators: attach metadata to prototype
                traverse(astWithDecorators as any, {
                  ClassDeclaration(path) {
                    const cls = path.node;
                    const name = cls.id ? cls.id.name : null;
                    if (!name) return;
                    const assigns: t.Statement[] = [];
                    for (const el of cls.body.body) {
                      if ((t.isClassMethod(el) || t.isClassPrivateMethod(el)) && el.decorators && el.decorators.length) {
                        const decs = [] as Array<{type:string, args:any[]}>;
                        for (const d of el.decorators) {
                          if (t.isCallExpression(d.expression)) {
                            const id = d.expression.callee;
                            const args = d.expression.arguments;
                            const typeName = t.isIdentifier(id) ? id.name : (t.isMemberExpression(id) && t.isIdentifier(id.property) ? id.property.name : 'unknown');
                            const argExprs = args.map(a => a as t.Expression);
                            decs.push({ type: typeName, args: argExprs });
                          } else if (t.isIdentifier(d.expression)) {
                            decs.push({ type: d.expression.name, args: [] });
                          }
                        }
                        // remove decorators
                        el.decorators = [];
                        // create assignment: ClassName.prototype.method.__sfc_decorators = [{type:'click', args:[...]}];
                        const proto = t.memberExpression(t.memberExpression(t.identifier(name), t.identifier('prototype')), (el.key as any));
                        const decArray = t.arrayExpression(decs.map(dd => t.objectExpression([t.objectProperty(t.identifier('type'), t.stringLiteral(dd.type)), t.objectProperty(t.identifier('args'), t.arrayExpression(dd.args))])));
                        const assign = t.expressionStatement(t.assignmentExpression('=', t.memberExpression(proto, t.identifier('__sfc_decorators')), decArray));
                        assigns.push(assign);
                      }
                    }
                    if (assigns.length) {
                      // insert assigns after the class declaration
                      path.insertAfter(assigns);
                    }
                  },

                  
                  ClassExpression(path) {
                    // handle similar to ClassDeclaration by ensuring a variable name
                    const cls = path.node;
                    const parent = path.parentPath;
                    if (parent && t.isExportDefaultDeclaration(parent.node)) {
                      // use fixed identifier __SFC_CLS__ for anonymous default classes so other passes can reference it
                      const tmpId = t.identifier('__SFC_CLS__');
                      // capture any method decorators and build assignments to prototype
                      const assigns: t.Statement[] = [];
                      for (const el of cls.body.body) {
                        if ((t.isClassMethod(el) || t.isClassPrivateMethod(el)) && el.decorators && el.decorators.length) {
                          const decs: t.ObjectExpression[] = [];
                          for (const d of el.decorators) {
                            if (t.isCallExpression(d.expression)) {
                              const id = d.expression.callee;
                              const args = d.expression.arguments;
                              const typeName = t.isIdentifier(id) ? id.name : (t.isMemberExpression(id) && t.isIdentifier(id.property) ? id.property.name : 'unknown');
                              decs.push(t.objectExpression([t.objectProperty(t.identifier('type'), t.stringLiteral(typeName)), t.objectProperty(t.identifier('args'), t.arrayExpression(args as any))]));
                            } else if (t.isIdentifier(d.expression)) {
                              decs.push(t.objectExpression([t.objectProperty(t.identifier('type'), t.stringLiteral(d.expression.name)), t.objectProperty(t.identifier('args'), t.arrayExpression([]))]));
                            }
                          }
                          // create assignment: __SFC_CLS__.prototype.method.__sfc_decorators = [ ... ]
                          const key = el.key && t.isIdentifier(el.key) ? el.key : t.stringLiteral('unknown');
                          const proto = t.memberExpression(t.memberExpression(t.identifier('__SFC_CLS__'), t.identifier('prototype')), key as any);
                          const decArray = t.arrayExpression(decs as any);
                          const assign = t.expressionStatement(t.assignmentExpression('=', t.memberExpression(proto, t.identifier('__sfc_decorators')), decArray));
                          assigns.push(assign);
                        }
                      }

                      // replace export default class { } with const __SFC_CLS__ = class { }; export default __SFC_CLS__; and append assigns
                      const newDecl = t.variableDeclaration('const', [t.variableDeclarator(tmpId, cls)]);
                      const exportDecl = t.exportDefaultDeclaration(tmpId);
                      // replace the parent export default with the new decls
                      parent.replaceWithMultiple([newDecl, exportDecl, ...assigns]);
                    }
                  }
                });

                const out = generate.default(astWithDecorators as any, { concise: false }).code;
                return out;
              }

              // fallback: use comment-based approach (original logic)
              const ast = parser.parse(replaced, { sourceType: 'module', plugins: ['typescript'] });

              traverse(ast as any, {
                ExportDefaultDeclaration(path) {
                  const decl = path.node.declaration;
                  if (t.isObjectExpression(decl)) {
                    const props = decl.properties.slice();
                    const newProps: t.ObjectProperty[] = [];
                    for (const p of props) {
                      if (t.isObjectMethod(p) || (t.isObjectProperty(p) && (t.isFunctionExpression(p.value) || t.isArrowFunctionExpression(p.value)))) {
                        const node = p as any;
                        const leading = (node.leadingComments || [])
                          .map((c: any) => c.value.trim())
                          .filter((v: string) => v.startsWith('__sfc_decorator:'));
                        if (leading.length === 0 && node.key && node.key.leadingComments) {
                          // sometimes comment attaches to key
                          const kleading = (node.key.leadingComments || []).map((c: any) => c.value.trim()).filter((v: string) => v.startsWith('__sfc_decorator:'));
                          if (kleading.length) leading.push(...kleading);
                        }

                        if (leading.length) {
                          // extract function params and body
                          let fnNode: t.FunctionExpression | null = null;
                          if (t.isObjectMethod(p)) {
                            fnNode = t.functionExpression(null, p.params as any, p.body as any, p.generator, p.async);
                          } else {
                            const vp = (p as t.ObjectProperty).value as any;
                            if (t.isFunctionExpression(vp)) fnNode = vp;
                            else if (t.isArrowFunctionExpression(vp)) {
                              fnNode = t.functionExpression(null, vp.params as any, t.isBlockStatement(vp.body) ? vp.body : t.blockStatement([t.returnStatement(vp.body as any)]));
                            }
                          }
                          if (!fnNode) { newProps.push(p as any); continue; }

                          // parse decorators from comments
                          const decs: Array<{type:string, args:string}> = [];
                          for (const cm of leading) {
                            const parts = cm.split(':');
                            // format __sfc_decorator:name:encodedArgs
                            if (parts.length >= 2) {
                              const name = parts[1] || '';
                              const enc = parts[2] || '';
                              const args = enc ? decodeURIComponent(enc) : '';
                              decs.push({ type: name, args });
                            }
                          }

                          // create IIFE that returns function and attaches __sfc_decorators
                          const decoratorsArray = t.arrayExpression(decs.map(d => {
                            const argsList: t.Expression[] = [];
                            if (d.args) {
                              const parts = d.args.split(',').map(s => s.trim()).filter(Boolean);
                              for (const tok of parts) {
                                if (/^['"].*['"]$/.test(tok)) {
                                  argsList.push(t.stringLiteral(tok.slice(1, -1)));
                                } else if (/^\d+$/.test(tok)) {
                                  argsList.push(t.numericLiteral(Number(tok)));
                                } else if (tok === 'true' || tok === 'false') {
                                  argsList.push(t.booleanLiteral(tok === 'true'));
                                } else {
                                  argsList.push(t.stringLiteral(tok));
                                }
                              }
                            }
                            return t.objectExpression([
                              t.objectProperty(t.identifier('type'), t.stringLiteral(d.type)),
                              t.objectProperty(t.identifier('args'), t.arrayExpression(argsList))
                            ]);
                          }));

                          // build: (function(){ const fn = function(...) { ... }; fn.__sfc_decorators = [...]; return fn })()
                          const fnId = t.identifier('fn');
                          const decl = t.variableDeclaration('const', [t.variableDeclarator(fnId, fnNode)]);
                          const assignExpr = t.expressionStatement(t.assignmentExpression('=', t.memberExpression(fnId, t.identifier('__sfc_decorators')), decoratorsArray));
                          const ret = t.returnStatement(fnId);
                          const iife = t.callExpression(t.parenthesizedExpression(t.functionExpression(null, [], t.blockStatement([decl, assignExpr, ret]))), []);

                          const key = (t.isObjectMethod(p) || t.isObjectProperty(p)) ? (p as any).key : t.identifier('unknown');
                          const newProp = t.objectProperty(key as any, iife);
                          newProps.push(newProp as any);
                          continue;
                        }
                      }
                      newProps.push(p as any);
                    }
                    decl.properties = newProps as any;
                  }
                }
              });

              const out = generate.default(ast as any, { concise: false }).code;
              return out;
          } catch (err) {
            // parsing/transformation failed, signal failure to caller
            throw err;
          }
        }

        function simplePreprocess(src: string) {
          // simple regex fallback: remove @decorator tokens (no args support)
          return src.replace(/@([A-Za-z_$][\w$]*)(\s*\(([^)]*)\))?\s*/g, '');
        }

        let preprocessed = scriptContent || '';
        try {
          preprocessed = astPreprocessDecorators(scriptContent || '');
        } catch (err) {
          preprocessed = simplePreprocess(scriptContent || '');
        }
        // use esbuild to transpile TypeScript to ESM for dev speed
        try {
          const cacheKey = real + '::script';
          const stat = fs.statSync(file);
          const mtime = stat.mtimeMs;
          const cache = (this as any)._sfcCache;
          const cached = cache.get(cacheKey);
          if (cached && cached.mtime === mtime) return cached.code;
          const res = await esbuild.transform(preprocessed || 'export default {}', { loader: 'ts', sourcemap: 'inline', format: 'esm', target: 'es2022', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } });
          // try to inject prototype assignments into the transformed code for anonymous default classes
          let finalCode = res.code;
          try {
            // simple scan of original scriptContent for @decorator('selector') on anonymous default class
            if (/export\s+default\s+class/.test(scriptContent || '')) {
              const assigns: string[] = [];
              const methodRe = /@([A-Za-z_$][\w$]*)\s*(?:\s*\(\s*(?:(['\"])([^\2]*?)\2\s*)?\)\s*)?\s*([A-Za-z_$][\w$]*)\s*\(/g;
              let mm: RegExpExecArray | null;
              while ((mm = methodRe.exec(scriptContent || '')) !== null) {
                const dec = mm[1];
                const arg = mm[3] || '';
                const method = mm[4];
                assigns.push(`if (typeof __SFC_CLS__ !== 'undefined') { try { __SFC_CLS__.prototype.${method}.__sfc_decorators = [{type:'${dec}', args:[${arg ? `'${arg}'` : ''}]}]; } catch(e){} }`);
              }
              if (assigns.length) {
                finalCode = finalCode + '\n' + assigns.join('\n');
              }
            }
          } catch (e) {
            // ignore injection errors
          }
          cache.set(cacheKey, { mtime, code: finalCode });
          try {
            const debugDir = path.resolve(process.cwd(), '.sfc-debug');
            if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir);
            const name = path.basename(file).replace(/[^a-z0-9.-]/gi, '_') + '.script.js';
            fs.writeFileSync(path.join(debugDir, name), finalCode, 'utf8');
          } catch (e) {
            // ignore debug write errors
          }
          return finalCode;
        } catch (e) {
          // If esbuild failed, try using TypeScript's transpileModule to strip types
          try {
            const transpiled = ts.transpileModule(preprocessed || scriptContent || '', {
              compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.ES2022,
                experimentalDecorators: true,
                jsx: ts.JsxEmit.Preserve
              }
            });
            let finalCode = transpiled.outputText || (preprocessed || scriptContent || 'export default {}');
            // simple injection for anonymous class decorator metadata (same as before)
            try {
              if (/export\s+default\s+class/.test(scriptContent || '')) {
                const assigns: string[] = [];
                const methodRe = /@([A-Za-z_$][\w$]*)\s*(?:\s*\(\s*(?:(['\"])\3([^\2]*?)\2\s*)?\)\s*)?\s*([A-Za-z_$][\w$]*)\s*\(/g;
                let mm: RegExpExecArray | null;
                while ((mm = methodRe.exec(scriptContent || '')) !== null) {
                  const dec = mm[1];
                  const arg = mm[3] || '';
                  const method = mm[4];
                  assigns.push(`if (typeof __SFC_CLS__ !== 'undefined') { try { __SFC_CLS__.prototype.${method}.__sfc_decorators = [{type:'${dec}', args:[${arg ? `'${arg}'` : ''}]}]; } catch(e){} }`);
                }
                if (assigns.length) finalCode = finalCode + '\n' + assigns.join('\n');
              }
            } catch (ee) {}

            const cacheKey = real + '::script';
            try { const cache = (this as any)._sfcCache; const stat = fs.statSync(file); cache.set(cacheKey, { mtime: stat.mtimeMs, code: finalCode }); } catch (ee) {}
            try {
              const debugDir = path.resolve(process.cwd(), '.sfc-debug');
              if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir);
              const name = path.basename(file).replace(/[^a-z0-9.-]/gi, '_') + '.script.js';
              fs.writeFileSync(path.join(debugDir, name), finalCode, 'utf8');
            } catch (ee) {}
            return finalCode;
          } catch (ee) {
            // As a last resort, return a stripped version without decorator tokens
            try { return simplePreprocess(scriptContent || '') || 'export default {}'; } catch (eee) { return 'export default {}'; }
          }
        }
      }
      return null;
    },

    async transform(code, id) {
      if (!id.endsWith('.sfc')) return null;
      // parse and transform into JS module
      const result = await transformSFC(code, id);
      try {
        const debugDir = path.resolve(process.cwd(), '.sfc-debug');
        if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir);
        const name = path.basename(id).replace(/[^a-z0-9.-]/gi, '_') + '.js';
        fs.writeFileSync(path.join(debugDir, name), result.code, 'utf8');
      } catch (e) {
        // ignore debug write errors
      }
      return {
        code: result.code,
        map: result.map
      };
    },

    async handleHotUpdate(ctx) {
      const { file, server, modules } = ctx;
      if (!file || !file.endsWith('.sfc')) return null;
      try {
        const cache = (this as any)._sfcCache as Map<string, any>;
        const scriptKey = file + '::script';
        if (cache && cache.has(scriptKey)) cache.delete(scriptKey);

        // re-run the transform to ensure SCSS is compiled the same way as transform hook
        const src = fs.readFileSync(file, 'utf8');
        let transformed: any = null;
        try {
          transformed = await transformSFC(src, file);
        } catch (e) {
          // fallback to naive extraction
        }

        let template = '';
        let css = '';
        let css_global = '';
        if (transformed) {
          template = transformed.template || '';
          css = transformed.css || '';
          css_global = transformed.css_global || '';
        } else {
          const tplMatch = src.match(/<template[^>]*>([\s\S]*?)<\/template>/i);
          const styleMatch = src.match(/<style([^>]*)>([\s\S]*?)<\/style>/i);
          template = tplMatch ? tplMatch[1].trim() : '';
          css = styleMatch ? styleMatch[2].trim() : '';
          css_global = '';
        }

        // broadcast update via vite websocket (send compiled css and global css when available)
        try {
          server.ws.send({ type: 'custom', event: 'sfc:update', data: { file, template, css, css_global } });
        } catch (e) {}

        // return modules to be reloaded normally as well
        if (modules && modules.length) return modules;
        return Array.from(server.moduleGraph.getModulesByFile(file) || []);
      } catch (e) {
        return null;
      }
    },

    // During build, generate standalone HTML files per discovered route that reference
    // the primary JS chunk produced by the build. We emit assets so they land
    // in the `dist/` output.
    async generateBundle(_options, bundle) {
        try {
          const routes = getRoutes();
          // emit a routes manifest for debugging and to inspect what was discovered
          try {
            this.emitFile({ type: 'asset', fileName: 'routes-manifest.json', source: JSON.stringify(routes, null, 2) });
          } catch (e) {}

          // find a primary entry chunk (first entry chunk) to reference from HTML files
          let mainFile = null as null | string;
          for (const [fileName, item] of Object.entries(bundle)) {
            const it: any = item as any;
            if (it.type === 'chunk' && it.isEntry) { mainFile = fileName; break; }
          }
          // fallback to any JS asset
          if (!mainFile) {
            for (const [fileName, item] of Object.entries(bundle)) {
              const it: any = item as any;
              if ((it.type === 'chunk' && fileName.endsWith('.js')) || (it.type === 'asset' && fileName.endsWith('.js'))) { mainFile = fileName; break; }
            }
          }
          if (!mainFile) mainFile = 'assets/app.js';

          for (const r of routes) {
            try {
              if (r.isRedirect === 'true' || r.isRedirect === true) {
                // emit a small redirect HTML file at the route path
                const destParts = (String(r.path || '/')).split('/').filter(Boolean).map(p => p.startsWith(':') ? `[${p.slice(1)}]` : p);
                const filePath = destParts.length ? path.posix.join(...destParts, 'index.html') : 'index.html';
                const redirectTo = r.redirect || '/';
                const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${redirectTo}"></head><body></body></html>`;
                this.emitFile({ type: 'asset', fileName: filePath, source: html });
                continue;
              }

              if (r.handlerOnly) {
                // handler-only routes don't have a component to render; skip HTML generation
                continue;
              }

              const destParts = (String(r.path || '/')).split('/').filter(Boolean).map(p => p.startsWith(':') ? `[${p.slice(1)}]` : p);
              const filePath = destParts.length ? path.posix.join(...destParts, 'index.html') : 'index.html';

              const tag = r.tag || (r.component ? (() => {
                // try to infer tag from component filename: components/FooBar.sfc -> foo-bar
                try {
                  const comp = String(r.component || '');
                  const name = path.basename(comp).replace(/\.sfc$/i, '');
                  // convert CamelCase/ Pascal to dashed-case
                  const dashed = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();
                  return dashed;
                } catch (e) { return 'div'; }
              })() : 'div');

              const tagOpen = `<${tag}></${tag}>`;
              const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${r.path}</title></head><body><div id="app">${tagOpen}</div><script type="module" src="/${mainFile}"></script></body></html>`;
              this.emitFile({ type: 'asset', fileName: filePath, source: html });
            } catch (e) {
              // continue on per-route errors
            }
          }
        } catch (e) {
          // don't break the build on generation errors
        }
      }
    };
  }

