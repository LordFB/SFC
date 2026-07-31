type DirectiveOwner = HTMLElement & {
  __sfc_directive_cleanup?: Array<() => void>;
};

function splitTopLevel(source: string, separator: string): string[] {
  const parts: string[] = [];
  let quote = '';
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') depth -= 1;
    else if (separator.includes(character) && depth === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts.filter(Boolean);
}

function parseArgument(source: string, event: Event): unknown {
  const value = source.trim();
  if (value === '$event') return event;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value === 'undefined') return undefined;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).replace(/\\([\\'"nrt])/g, (_match, escaped) => ({ n: '\n', r: '\r', t: '\t' }[escaped] || escaped));
  }
  throw new SyntaxError(`Unsupported directive argument: ${value}`);
}

function bindComponentCall(owner: DirectiveOwner, element: Element, eventName: string, directiveName: string, expression: string, cleanup: Array<() => void>): void {
  const call = expression.trim().match(/^([a-zA-Z_$][\w$]*)(?:\s*\(([\s\S]*)\))?$/);
  if (!call) throw new SyntaxError(`Invalid ${directiveName} expression: ${expression}`);
  const methodName = call[1];
  const argumentSource = call[2];
  const handler = (event: Event) => {
    const method = (owner as unknown as Record<string, unknown>)[methodName];
    if (typeof method !== 'function') throw new TypeError(`${directiveName} method not found: ${methodName}`);
    const args = argumentSource === undefined || !argumentSource.trim()
      ? []
      : splitTopLevel(argumentSource, ',').map(argument => parseArgument(argument, event));
    return method.apply(owner, args);
  };
  element.addEventListener(eventName, handler);
  cleanup.push(() => element.removeEventListener(eventName, handler));
}

function cssPropertyName(source: string): string {
  const property = source.trim().replace(/^['"]|['"]$/g, '');
  if (!/^(?:--[\w-]+|[a-zA-Z][\w-]*)$/.test(property)) throw new SyntaxError(`Invalid CSS property: ${source}`);
  return property.startsWith('--') ? property : property.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`);
}

function cssValue(source: string): string {
  const value = source.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  if (!value) throw new SyntaxError(`Invalid CSS value: ${source}`);
  return value;
}

function parseCssObject(expression: string): Array<[string, string]> {
  const object = expression.trim().match(/^\{([\s\S]*)\}$/);
  if (!object) throw new SyntaxError(`@Hover expects a component function or CSS object: ${expression}`);
  return splitTopLevel(object[1], ',;').map(declaration => {
    const pair = splitTopLevel(declaration, ':');
    if (pair.length !== 2) throw new SyntaxError(`Invalid CSS declaration: ${declaration}`);
    return [cssPropertyName(pair[0]), cssValue(pair[1])];
  });
}

function bindHover(owner: DirectiveOwner, element: HTMLElement, expression: string, cleanup: Array<() => void>): void {
  if (!expression.trim().startsWith('{')) {
    bindComponentCall(owner, element, 'mouseenter', '@Hover', expression, cleanup);
    return;
  }
  const declarations = parseCssObject(expression);
  const previous = declarations.map(([property]) => [
    property,
    element.style.getPropertyValue(property),
    element.style.getPropertyPriority(property)
  ] as const);
  const enter = () => {
    for (const [property, value] of declarations) element.style.setProperty(property, value);
  };
  const leave = () => {
    for (const [property, value, priority] of previous) {
      if (value) element.style.setProperty(property, value, priority);
      else element.style.removeProperty(property);
    }
  };
  element.addEventListener('mouseenter', enter);
  element.addEventListener('mouseleave', leave);
  cleanup.push(() => {
    element.removeEventListener('mouseenter', enter);
    element.removeEventListener('mouseleave', leave);
    leave();
  });
}

export function connectTemplateDirectives(owner: DirectiveOwner, root: Element | ShadowRoot): void {
  disconnectTemplateDirectives(owner);
  const cleanup: Array<() => void> = [];
  for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      try {
        if (name === '@click') bindComponentCall(owner, element, 'click', '@Click', attribute.value, cleanup);
        else if (name === '@hover') bindHover(owner, element, attribute.value, cleanup);
        else continue;
        element.removeAttribute(attribute.name);
      } catch (error) {
        console.error(`[sfc] ${attribute.name} directive failed`, error);
      }
    }
  }
  owner.__sfc_directive_cleanup = cleanup;
}

export function disconnectTemplateDirectives(owner: DirectiveOwner): void {
  for (const dispose of owner.__sfc_directive_cleanup || []) {
    try { dispose(); } catch {}
  }
  owner.__sfc_directive_cleanup = [];
}
