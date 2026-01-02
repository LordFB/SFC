import MagicString from 'magic-string';
import fs from 'fs';
import path from 'path';

// Pre-compiled regex patterns for performance (compile once, reuse many times)
const TEMPLATE_RE = /<template[^>]*>([\s\S]*?)<\/template>/i;
const SCRIPT_RE = /<script[^>]*>([\s\S]*?)<\/script>/i;
const STYLE_RE = /<style([^>]*)>([\s\S]*?)<\/style>/i;
const ROUTE_RE = /<route([^>]*)>([\s\S]*?)<\/route>/i;
const ROUTE_SELF_CLOSE_RE = /<route([^>]*)\s*\/?>/i;
const ATTR_RE = /([a-zA-Z0-9-:]+)\s*=\s*"([^"]*)"/g;
const PARAM_RE = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
const TAG_RE = /(?:static\s+)?tag\s*[=:]\s*['"`]([^'"`]+)['"`]/;
const DASHED_TAG_RE = /<([a-z][a-z0-9-]*)[\s/>]/gi;
const STYLE_GLOBAL_RE = /<style([^>]*)>([\s\S]*?)<\/style>/gi;
const LANG_RE = /lang\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i;
const GLOBAL_ATTR_RE = /\bglobal(?:\s*=\s*(?:"true"|'true'|true))?\b/i;
const EXPORT_DEFAULT_CLASS_RE = /export\s+default\s+class/;
const METHOD_DECORATOR_RE = /@([A-Za-z_$][\w$]*)\s*(?:\s*\(\s*(?:(['\"])([^\2]*?)\2\s*)?\)\s*)?\s*([A-Za-z_$][\w$]*)\s*\(/g;

// Memoization caches
const tagScanCache = new Map<string, Record<string, string>>();
const sassModule: { compile?: typeof import('sass').compileString } = {};

export async function transformSFC(code: string, id: string) {
  // Simple regex extraction for <template>, <script>, <style>, and <route>
  const templateMatch = code.match(TEMPLATE_RE);
  const scriptMatch = code.match(SCRIPT_RE);
  const styleMatch = code.match(STYLE_RE);
  const routeMatch = code.match(ROUTE_RE) || code.match(ROUTE_SELF_CLOSE_RE);

  const template = templateMatch ? templateMatch[1].trim() : '';
  const script = scriptMatch ? scriptMatch[1].trim() : '';
  const style = styleMatch ? styleMatch[2].trim() : '';
  const styleAttrs = styleMatch ? styleMatch[1] : '';
  let route = null as null | { attrs: Record<string,string>, content: string, paramNames: string[] };
  if (routeMatch) {
    const attrString = routeMatch[1] || '';
    const attrs: Record<string,string> = {};
    // Use pre-compiled regex with reset
    ATTR_RE.lastIndex = 0;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = ATTR_RE.exec(attrString)) !== null) {
      attrs[attrMatch[1]] = attrMatch[2];
    }
    const content = routeMatch[2] || '';
    const paramNames: string[] = [];
    const routePath = attrs.path;
    if (routePath) {
      // Use pre-compiled regex
      const matches = routePath.match(PARAM_RE);
      if (matches) {
        paramNames.push(...matches.map(m => m.slice(1)));
      }
    }
    // Support redirect and method attributes for redirect routes
    if (attrs.redirect) {
      // For redirect routes, no tag/component is needed
      attrs.isRedirect = 'true';
      // Optionally, parse method (default 302 if not 301)
      attrs.redirectMethod = attrs.method || '302';
    } else {
      // try to infer tag from script if not provided; mark handlerOnly when absent
      if (!attrs.tag) {
        const scriptTagMatch = script.match(TAG_RE);
        if (scriptTagMatch) {
          attrs.tag = scriptTagMatch[1];
        } else {
          attrs.handlerOnly = 'true';
        }
      }
    }
    route = { attrs, content, paramNames };
  }

  // assemble a basic JS module that registers a simple custom element
  const ms = new MagicString('');
  ms.append(`import { defineComponent, attachStyles } from "/src/runtime/index";\n`);

  // Auto-detect dashed tag names in the template and try to inject side-effect imports
  // for corresponding .sfc files under the project's components/ directory so nested
  // components are registered when the parent module executes.
  try {
    // Reset the global regex before use
    DASHED_TAG_RE.lastIndex = 0;
    const found = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = DASHED_TAG_RE.exec(template))) {
      const name = m[1];
      if (name.includes('-')) found.add(name);
    }

    if (found.size) {
      const componentsDir = path.resolve(process.cwd(), 'components');
      const tagToPath: Record<string,string> = {};

      // helper: recursively scan components dir for .sfc files and check their declared tag
      function scanComponents(dir: string) {
        const list = fs.readdirSync(dir);
        for (const file of list) {
          const full = path.join(dir, file);
          const st = fs.statSync(full);
          if (st.isDirectory()) {
            scanComponents(full);
          } else if (file.endsWith('.sfc')) {
            const content = fs.readFileSync(full, 'utf8');
            const scriptMatch = content.match(/<script[\s\S]*?>([\s\S]*?)<\/script>/i);
            const script = scriptMatch ? scriptMatch[1] : '';
            const tagMatch = script.match(/(?:static\s+)?tag\s*[=:]\s*['"`]([^'"`]+)['"`]/);
            const rel = full;
            if (tagMatch) {
              const tagName = tagMatch[1];
              for (const t of Array.from(found)) {
                if (!tagToPath[t] && tagName === t) tagToPath[t] = rel;
              }
            }
            // also map by filename heuristics: folder/file matching tag parts (e.g., site-nav -> components/site/Nav.sfc)
            const base = path.basename(file, '.sfc');
            for (const t of Array.from(found)) {
              if (tagToPath[t]) continue;
              const parts = t.split('-');
              if (parts.length >= 2) {
                const folder = parts[0];
                const fname = parts.slice(1).map(p => p[0].toUpperCase() + p.slice(1)).join('');
                const cand1 = path.join(componentsDir, folder, fname + '.sfc');
                const cand2 = path.join(componentsDir, folder, parts.slice(1).join('-') + '.sfc');
                if (full === cand1 || full === cand2) {
                  // avoid mapping the parent file to itself
                  if (path.resolve(full) !== path.resolve(id)) {
                    tagToPath[t] = rel;
                  }
                }
              }
              // fallback: filename equals tag (case-insensitive)
              if (!tagToPath[t] && base.toLowerCase() === t.toLowerCase() && path.resolve(full) !== path.resolve(id)) tagToPath[t] = rel;
            }
          }
        }
      }

      try { if (fs.existsSync(componentsDir)) scanComponents(componentsDir); } catch(e){}

      // For each mapped tag, inject a side-effect import relative to this sfc's id
      const imports: string[] = [];
      for (const t of Object.keys(tagToPath)) {
        const p = tagToPath[t];
        if (!p) continue;
        try {
          const fromDir = path.dirname(id || '');
          let relPath = path.relative(fromDir, p).replace(/\\/g, '/');
          if (!relPath.startsWith('.')) relPath = './' + relPath;
          // import the .sfc file so the transformed module executes and registers the element
          imports.push(`import ${JSON.stringify(relPath)};`);
        } catch (e) {
          // ignore
        }
      }
      if (imports.length) {
        ms.append(imports.join('\n') + '\n');
      }
    }
  } catch (e) {
    // non-fatal: if auto-inject fails, continue without it
  }

  // attach styles
  // Support multiple <style> blocks and a `global` attribute on a style
  // To avoid picking up example <style> tags inside the <template> or <script>
  // content, scan a copy of the source with those blocks removed.
  let scanSource = code;
  try {
    if (templateMatch && templateMatch[0]) scanSource = scanSource.replace(templateMatch[0], '');
  } catch (e) {}
  try {
    if (scriptMatch && scriptMatch[0]) scanSource = scanSource.replace(scriptMatch[0], '');
  } catch (e) {}

  // Reset global regex before use
  STYLE_GLOBAL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const localParts: string[] = [];
  const globalParts: string[] = [];
  while ((m = STYLE_GLOBAL_RE.exec(scanSource)) !== null) {
    const attrs = m[1] || '';
    const content = (m[2] || '').trim();
    if (!content) continue;
    // detect lang and global attributes using pre-compiled regex
    let lang = null as string | null;
    const lm = attrs.match(LANG_RE);
    if (lm) lang = lm[1] || lm[2] || lm[3] || null;
    const globalAttr = GLOBAL_ATTR_RE.test(attrs);

    let compiled = content;
    if (lang && lang.toLowerCase() === 'scss' && content) {
      try {
        // Lazy-load and cache sass module for performance
        if (!sassModule.compile) {
          const sass = await import('sass');
          sassModule.compile = sass.compileString;
        }
        const out = sassModule.compile(content, { style: 'expanded' });
        compiled = out.css;
      } catch (e) {
        compiled = content;
        ms.append(`// [sfc] warning: failed to compile SCSS for ${id}, falling back to raw CSS. Install 'sass' to enable SCSS compilation.\n`);
      }
    }

    if (globalAttr) globalParts.push(compiled);
    else localParts.push(compiled);
  }

  const localCss = localParts.length ? localParts.join('\n') : null;
  const globalCss = globalParts.length ? globalParts.join('\n') : null;

  if (localCss) {
    const css = localCss.replace(/`/g, '\\`');
    ms.append(`const __css = ` + '`' + css + '`' + `;\n`);
  } else {
    ms.append(`const __css = null;\n`);
  }

  if (globalCss) {
    const gcss = globalCss.replace(/`/g, '\\`');
    ms.append(`const __css_global = ` + '`' + gcss + '`' + `;\n`);
  } else {
    ms.append(`const __css_global = null;\n`);
  }

  // __attach applies both local and global styles to the provided root. This ensures
  // global styles are present inside shadow roots as well as on light DOM mounts.
  ms.append(`function __attach(root){ if(__css) attachStyles(root, __css); if(__css_global) attachStyles(root, __css_global); }\n`);

  // include template as a string
  const tpl = template.replace(/`/g, '\\`');
  ms.append(`const __template = ` + '`' + tpl + '`' + `;\n`);


  // include route meta if present
  if (route) {
    const routeData = { ...route.attrs, paramNames: route.paramNames };
    const r = JSON.stringify(routeData);
    ms.append(`export const __route = ${r};\n`);
  } else {
    ms.append(`export const __route = null;\n`);
  }

  // import script as a virtual part so ESM exports are preserved
  if (script.trim()) {
    const scriptImportId = id + '?sfc-script';
    ms.append(`import * as __script from ${JSON.stringify(scriptImportId)};\n`);
    ms.append(`const __script_default = (__script && __script.default) || __script;\n`);
    ms.append(`__script_default.__sfc_template = __template;\n`);
    ms.append(`__script_default.__sfc_attach = __attach;\n`);
    if (route) {
      const routeData = { ...route.attrs, paramNames: route.paramNames };
      ms.append(`__script_default.__route = ${JSON.stringify(routeData)};\n`);
    }
    // Best-effort: scan original script text for simple class-method decorators and emit prototype assignments
    try {
      if (/export\s+default\s+class/.test(script)) {
        const assigns: string[] = [];
        const methodRe = /@([A-Za-z_$][\w$]*)\s*(?:\s*\(\s*(?:(['\"])([^\2]*?)\2\s*)?\)\s*)?\s*([A-Za-z_$][\w$]*)\s*\(/g;
        let m: RegExpExecArray | null;
        while ((m = methodRe.exec(script)) !== null) {
          const dec = m[1];
          const arg = m[3] || '';
          const method = m[4];
          // we will append assignments that reference a temporary class variable when loaded
          assigns.push(`if (typeof __script_default === 'function') { /* constructor already exported */ } else { try { if (typeof __SFC_CLS__ !== 'undefined') { __SFC_CLS__.prototype.${method}.__sfc_decorators = [{type:'${dec}', args:[${arg ? `'${arg}'` : ''}]}]; } } catch(e){} }`);
        }
        if (assigns.length) {
          // append assignments that target __script_default.prototype so metadata lands on imported constructor
          ms.append(`\n// sfc: appended prototype decorator metadata on __script_default.prototype\n`);
          for (const a of assigns) {
            const nameMatch = a.match(/prototype\.([A-Za-z_$][\w$]*)/);
            const methodName = nameMatch ? nameMatch[1] : 'unknown';
            const decMatch = a.match(/\{type:'([^']+)', args:\['([^']*)'\]\}/);
            const decType = decMatch ? decMatch[1] : 'unknown';
            const decArg = decMatch ? decMatch[2] : '';
            const stmt = `try {
  if (typeof __script_default === 'function') {
    __script_default.prototype.${methodName}.__sfc_decorators = [{type:'${decType}', args:[${decArg ? `'${decArg}'` : ''}]}];
  } else if (typeof __SFC_CLS__ !== 'undefined') {
    __SFC_CLS__.prototype.${methodName}.__sfc_decorators = [{type:'${decType}', args:[${decArg ? `'${decArg}'` : ''}]}];
  } else if (__script_default && typeof __script_default === 'object' && __script_default.${methodName}) {
    __script_default.${methodName}.__sfc_decorators = [{type:'${decType}', args:[${decArg ? `'${decArg}'` : ''}]}];
  }
} catch(e){}
`;
            ms.append(stmt);
          }
        }
      }
    } catch (e) {
      // ignore
    }
    ms.append(`let __component = null;\n`);
    ms.append(`if (typeof __script_default === 'function') {\n`);
    ms.append(`  // assume this is a constructor/class - register directly\n`);
    ms.append(`  __component = defineComponent(__script_default);\n`);
    ms.append(`} else {\n`);
    ms.append(`  const opts = Object.assign({}, __script_default || {});\n`);
    ms.append(`  opts.template = __template;\n`);
    ms.append(`  opts._attach = __attach;\n`);
    if (route) {
      const routeData = { ...route.attrs, paramNames: route.paramNames };
      ms.append(`  opts.__route = ${JSON.stringify(routeData)};\n`);
    }
    ms.append(`  __component = defineComponent(opts);\n`);
    ms.append(`}\n`);
    ms.append(`export default __component;\n`);
  } else {
    ms.append(`const opts = {};\n`);
    ms.append(`opts.template = __template;\n`);
    ms.append(`opts._attach = __attach;\n`);
    if (route) {
      const routeData = { ...route.attrs, paramNames: route.paramNames };
      ms.append(`opts.__route = ${JSON.stringify(routeData)};\n`);
    }
    ms.append(`export default defineComponent(opts);\n`);
  }

  const finalCode = ms.toString();
  // If global CSS was present, also emit a module-time attach to document so
  // global styles are applied as soon as the module executes (dev + build).
  if (globalCss) {
    ms.append(`try{ if (typeof window !== 'undefined') { (window.__sfc_global_styles = window.__sfc_global_styles || []); window.__sfc_global_styles.push(__css_global); } if (typeof document !== 'undefined' && __css_global) { attachStyles(document, __css_global); } } catch(e) { }\n`);
  }

  const map = ms.generateMap({ hires: true });
  return { code: ms.toString(), map, css: localCss, css_global: globalCss, template };
}
