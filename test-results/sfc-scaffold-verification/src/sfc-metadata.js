import * as parser from '@babel/parser';

function stringValue(node) {
  return node?.type === 'StringLiteral' ? node.value : null;
}

function propertyName(node) {
  if (!node) return null;
  if (node.type === 'Identifier' && !node.computed) return node.name;
  return stringValue(node);
}

/**
 * Read the component tag from the actual default export.
 *
 * Metadata must be syntax-aware: documentation pages and playgrounds commonly
 * contain complete SFC examples in strings, and a regex cannot distinguish
 * those examples from executable declarations.
 */
export function extractComponentTag(script) {
  if (!script.trim()) return null;

  try {
    const ast = parser.parse(script, {
      sourceType: 'module',
      plugins: ['typescript', 'decorators-legacy', 'classProperties']
    });

    for (const statement of ast.program.body) {
      if (statement.type !== 'ExportDefaultDeclaration') continue;
      const declaration = statement.declaration;

      if (declaration?.type === 'ClassDeclaration' || declaration?.type === 'ClassExpression') {
        for (const member of declaration.body.body) {
          if (!member.static || propertyName(member.key) !== 'tag') continue;
          const value = stringValue(member.value);
          if (value) return value;
        }
      }

      if (declaration?.type === 'ObjectExpression') {
        for (const property of declaration.properties) {
          if (property.type !== 'ObjectProperty' || propertyName(property.key) !== 'tag') continue;
          const value = stringValue(property.value);
          if (value) return value;
        }
      }
    }
  } catch {
    // Invalid scripts are diagnosed by the normal transform stage. Returning no
    // metadata here prevents a string literal from becoming a route component.
  }

  return null;
}
