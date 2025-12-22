# SFC Framework

A Vite plugin for building Single-File Components (`.sfc`) that compile to native Web Components (Custom Elements). Write components using familiar Vue-like syntax, but output standards-compliant web components with Shadow DOM support, SCSS compilation, and TypeScript.

## Quick Start

```bash
npm install
npm run dev
```

Open http://localhost:5173 to see your components in action.

## Writing Components

Create `.sfc` files in your `components/` folder. Each file contains up to four blocks:

### Basic Component

```html
<template>
  <div class="greeting">
    <h1>Hello, {{ name }}!</h1>
    <button class="greet-btn">Click me</button>
  </div>
</template>

<script lang="ts">
export default {
  tag: 'my-greeting',
  shadow: true,
  connectedCallback() {
    console.log('Component mounted with params:', this.params);
  },
  @click('.greet-btn')
  greet() {
    alert('Hello!');
  }
};
</script>

<style>
.greeting {
  padding: 20px;
  border: 1px solid #ccc;
}
</style>

<route path="/greet/:name" methods="GET" lazy="component" />
```

This component renders at `/greet/world` displaying "Hello, world!" with `this.params.name = 'world'`.

### Class-Based Component with Decorators

```html
<template>
  <input type="text" placeholder="Type something..." />
  <button class="submit-btn">Submit</button>
</template>

<script lang="ts">
export default class extends HTMLElement {
  static tag = 'my-form';

  @input('input')
  onInput(event: Event) {
    console.log('Input changed:', (event.target as HTMLInputElement).value);
  }

  @click('.submit-btn')
  onSubmit() {
    alert('Form submitted!');
  }
}
</script>

<style>
.submit-btn {
  margin-left: 10px;
  padding: 5px 10px;
}
</style>
```

## Component Options

Choose between object-based and class-based components based on your needs:

### Object-Based Components

Best for simple components with straightforward logic. The framework handles the Custom Element boilerplate for you.

```typescript
export default {
  tag: 'my-component',        // Required: custom element tag name (must contain hyphen)
  shadow: true,               // Optional: enables Shadow DOM for style encapsulation (default: false)
  observedAttributes: [],     // Optional: array of attribute names to watch for changes
  connectedCallback() {},     // Optional: called when component is added to DOM
  disconnectedCallback() {},  // Optional: called when component is removed from DOM
  attributeChangedCallback(name, oldVal, newVal) {} // Optional: called when observed attributes change
};
```

**When to use:** Simple components, rapid prototyping, when you want the framework to manage lifecycle details.

### Class-Based Components

Best for complex components requiring full control over the Custom Element lifecycle or advanced JavaScript features.

```typescript
export default class extends HTMLElement {
  static tag = 'my-component'; // Required: custom element tag name

  constructor() {
    super();
    // Full control over initialization
  }

  connectedCallback() {
    // Component mounted - access to DOM
  }

  disconnectedCallback() {
    // Component unmounted - cleanup resources
  }

  attributeChangedCallback(name, oldVal, newVal) {
    // React to attribute changes
  }
}
```

**When to use:** Complex state management, inheritance, advanced lifecycle control, or when migrating existing Custom Elements.

**Shadow DOM Considerations:**
- **Use `shadow: true` when:** You want complete style isolation, building reusable components, or preventing external CSS interference
- **Avoid `shadow: true` when:** You need global styles to affect the component, or when working with CSS frameworks that rely on global selectors

## Decorators

Decorators automatically wire event listeners and apply behavior modifiers to class-based component methods. They eliminate manual `addEventListener` calls and provide common behavior patterns.

### Event Decorators

Automatically attach event listeners to DOM elements:

```typescript
@click(selector)     // Handles click events
@input(selector)     // Handles input events (fires on every keystroke)
@change(selector)    // Handles change events (fires when input loses focus)
```

- `selector` is optional CSS selector (e.g., `'.btn'`, `'input'`)
- If omitted, listens on the component's root element
- Only available in class-based components

**Examples:**
```typescript
@click('.submit-btn')  // Listen for clicks on elements with class 'submit-btn'
@input('input')        // Listen for input changes on all input elements
@change()              // Listen for changes on the component root
```

**When to use:** Simplifies event handling, reduces boilerplate, ensures proper cleanup on component destruction.

### Behavior Decorators

Control how often methods are called:

```typescript
@debounce(delay)     // Waits until calls stop before executing (default: 200ms)
@throttle(delay)     // Limits execution to once per interval (default: 200ms)
```

**Debounce vs Throttle:**
- **Use `@debounce`** for search inputs, form validation, or actions that should only happen after user stops interacting
- **Use `@throttle`** for scroll handlers, resize events, or continuous actions that need regular updates

**Example:**
```typescript
@debounce(300)
onSearch(event) {
  // API call - only executes 300ms after user stops typing
}

@throttle(100)
onScroll(event) {
  // Update UI - executes at most every 100ms during scroll
}
```

**When to use:** Performance optimization for frequent events, preventing excessive API calls or DOM updates.

## Styling

Components support both standard CSS and SCSS preprocessing.

### CSS

Basic CSS styling with full browser support:

```html
<style>
.my-component {
  color: red;
  padding: 10px;
}

.my-component:hover {
  opacity: 0.8;
}
</style>
```

**When to use:** Simple styles, maximum browser compatibility, or when you prefer vanilla CSS.

### SCSS Support

Sass/SCSS preprocessing for advanced styling features:

```html
<style lang="scss">
$primary-color: #007bff;
$spacing: 10px;

.my-component {
  color: $primary-color;
  padding: $spacing;

  &:hover {
    color: darken($primary-color, 10%);
  }

  .nested-element {
    margin: $spacing * 2;
  }
}
</style>
```

**SCSS Features Available:**
- Variables (`$variable`)
- Nesting (`&` parent selector)
- Mixins and functions
- Mathematical operations
- Partials and imports (if configured)

**When to use SCSS:**
- Complex component libraries with design systems
- Need for reusable variables and mixins
- Advanced nesting for complex component structures
- Team already using Sass/SCSS

**When to avoid SCSS:**
- Simple components with minimal styling
- Performance-critical applications (adds compilation step)
- Team prefers vanilla CSS or other preprocessors

SCSS is compiled automatically when `lang="scss"` is specified. Requires `sass` package (installed automatically).

## Shadow DOM

Shadow DOM provides complete style and markup encapsulation for components.

### Enabling Shadow DOM

```typescript
export default {
  tag: 'my-component',
  shadow: true,  // Creates isolated DOM subtree
  // ...
};
```

### Benefits of Shadow DOM

**✅ Style Encapsulation:**
- Component styles don't leak to parent document
- Parent document styles don't affect component internals
- No CSS conflicts with global stylesheets

**✅ Markup Isolation:**
- Component's DOM is completely separate
- IDs and classes can be reused without conflicts
- Internal structure is hidden from parent document

**✅ True Component Boundaries:**
- Perfect for reusable component libraries
- Prevents accidental styling interference
- Maintains component integrity across applications

### Drawbacks of Shadow DOM

**❌ Global Style Limitations:**
- Cannot inherit global CSS custom properties (CSS variables) unless explicitly pierced
- Difficult to theme components from outside
- CSS frameworks (Bootstrap, Tailwind) don't work inside Shadow DOM

**❌ Inheritance Issues:**
- Some CSS properties don't inherit (like `color`, `font-family`)
- Must explicitly style inherited properties
- Layout can be affected by inheritance gaps

**❌ Browser Support:**
- Not supported in IE11 or older browsers
- Some CSS features work differently in Shadow DOM

### When to Use Shadow DOM

**Use `shadow: true` for:**
- Reusable component libraries distributed to third parties
- Components that must maintain visual consistency regardless of host page
- Enterprise applications with strict style isolation requirements
- Building design system components

**Avoid `shadow: true` for:**
- Applications using global CSS frameworks
- Components that need to inherit parent theming
- Simple internal components where isolation isn't critical
- Legacy browser support requirements

## Routing

Components can declare route metadata for client-side routing. The framework includes a simple router that instantiates components based on the current URL path.

### Route Declaration

```html
<route path="/dashboard" methods="GET" lazy="component" />
<route path="/users/:id" methods="GET,POST" lazy="component" />
```

**Route Attributes:**
- `path`: URL pattern (supports `:param` placeholders for route parameters)
- `methods`: HTTP methods this component handles (currently informational)
- `lazy`: Loading strategy (currently always "component" - all components are loaded eagerly)

### Parameter Access

Route parameters and query parameters are automatically parsed and made available in components:

```typescript
connectedCallback() {
  console.log('Route params:', this.routeParams);    // { id: '123' } for /users/123
  console.log('Query params:', this.queryParams);    // { foo: 'bar' } for ?foo=bar
  console.log('All params:', this.params);           // Combined object
}
```

### Template Interpolation

Use `{{ param }}` in templates for automatic parameter substitution:

```html
<template>
  <div>
    <h1>Welcome to {{ page }}</h1>
    <p>User ID: {{ id }}</p>
    <p>Search: {{ q }}</p>
  </div>
</template>
```

For `/users/123?page=dashboard&q=search`, this renders:
```html
<div>
  <h1>Welcome to dashboard</h1>
  <p>User ID: 123</p>
  <p>Search: search</p>
</div>
```

### Current Implementation

- **Client-Side Routing:** Simple path-based component instantiation
- **Parameter Parsing:** Automatic extraction of route params (`:param`) and query params
- **Component Loading:** All components loaded eagerly on app start
- **No Lazy Loading:** Components are not loaded on-demand yet

### Usage

The router automatically matches the current URL to component routes and instantiates the appropriate component in the document body. Navigate to different paths to see different components render.

**Example:** Visiting `http://localhost:5173/users/123?tab=profile` will render the component with `path="/users/:id"` and make `id`, `tab` available as `this.params.id`, `this.params.tab`.

### Future Plans

- Lazy loading based on routes
- Nested routing and route guards
- Server-side route manifest generation
- History API integration for SPA navigation

## Using Components

Components are automatically registered when the app starts via `import.meta.glob()`. The built-in router instantiates components based on the current URL path.

### Manual Usage

You can also manually instantiate components in HTML or JavaScript:

```html
<!-- index.html -->
<body>
  <my-greeting></my-greeting>
</body>
```

```javascript
// Manual instantiation
const component = document.createElement('my-greeting');
document.body.appendChild(component);
```

### Router-Based Usage

The router automatically handles component instantiation. Simply navigate to URLs that match component routes:

- `/greet/world` → renders `<my-greeting>` with `name = 'world'`
- `/users/123` → renders `<x-user>` with `id = '123'`
- `?tab=dashboard` → adds `tab = 'dashboard'` to params

Components are appended to `document.body` when their route matches.

## Development

### Scripts

- `npm run dev` - Start development server with HMR
- `npm run build` - Build for production
- `npm run preview` - Preview production build

### Hot Module Replacement (HMR)

Components automatically reload when you edit `.sfc` files. Template and style changes are applied instantly without full page reload.

### Debugging

- Check browser console for component lifecycle logs
- SFC parsing output is saved to `.sfc-debug/` folder during development
- Use browser dev tools to inspect Shadow DOM

## Project Structure

```
├── components/          # Your .sfc component files
├── src/
│   ├── main.ts         # App entry point with router initialization
│   ├── plugin.ts       # Vite plugin (internal)
│   ├── transformer.ts  # SFC parser (internal)
│   └── runtime/        # Runtime utilities (internal)
├── index.html          # Main HTML file
└── package.json
```

## Browser Support

Requires modern browsers with Custom Elements and ES modules support. For Shadow DOM, use evergreen browsers.

## Limitations (MVP)

This is a minimal viable product focused on core SFC-to-Web-Component compilation. Several features common in full frameworks are not yet implemented.

### Current Features

**✅ Template Interpolation**
- `{{ param }}` syntax automatically replaced with parameter values
- Works with route params (`:id`) and query params (`?key=value`)
- No manual DOM manipulation required

**✅ Basic Routing**
- Client-side routing with path-based component instantiation
- Automatic parameter parsing and injection
- Route metadata parsing from `<route>` blocks

**✅ Decorator Support**
- Event decorators: `@click`, `@input`, `@change`
- Behavior decorators: `@debounce`, `@throttle`
- Automatic event listener management and cleanup

### Missing Features

**No Reactive Data Binding**
- Components don't automatically update when data changes
- No computed properties or watchers
- **Workaround:** Use vanilla JavaScript in lifecycle hooks, manually update DOM

**Limited Event Decorators**
- Only `@click`, `@input`, `@change` available
- No `@submit`, `@focus`, `@blur`, etc. yet
- **Workaround:** Use traditional `addEventListener` for other events

**No Lazy Loading**
- All components loaded eagerly on app start
- No route-based code splitting
- **Workaround:** All components are small and loaded upfront

**No Advanced Routing**
- No nested routes or route guards
- No history API integration for SPA navigation
- **Workaround:** Simple path matching for basic routing

**No Build Optimizations**
- No route manifest generation
- No automatic CSS optimization
- **Workaround:** Use Vite's built-in optimizations

### Performance Considerations

- SCSS compilation happens at runtime (development only)
- No production CSS optimization
- Components loaded eagerly (not lazy)

### Browser Compatibility

- Requires ES2015+ support
- Custom Elements v1
- Shadow DOM v1 (optional but recommended)
- **Not supported:** IE11, older mobile browsers

### Development Experience

- Limited error messages for SFC syntax errors
- No TypeScript intellisense for component options
- Basic HMR (template/style only, not script changes)

### Migration Notes

If migrating from Vue/React:
- No `v-if`, `v-for`, or other directives
- No reactive `data()` or `props`
- Must use vanilla DOM manipulation
- Class-based components similar to custom elements, not framework components

## Contributing

This is an MVP prototype. The framework is designed to be minimal and focused on the core SFC-to-Web-Component transformation pipeline.

### Key Areas for Enhancement

**High Priority:**
- **Reactive Data Binding:** Add observable properties and automatic DOM updates
- **More Decorators:** Support for additional events (`@submit`, `@focus`, etc.) and behaviors
- **Advanced Routing:** Lazy loading, nested routes, route guards, history API integration

**Medium Priority:**
- **Build Optimizations:** Route manifest generation, CSS minification, tree shaking
- **Developer Experience:** Better error messages, TypeScript support, testing utilities
- **Performance:** Production SCSS compilation, CSS-in-JS alternatives

**Low Priority:**
- **Additional Preprocessors:** Less, Stylus, PostCSS support
- **Advanced Features:** Slots, component composition, context APIs

### Architecture Notes

- **Virtual Modules:** Script processing uses `?sfc-script` virtual modules to preserve ESM exports
- **AST Processing:** Babel AST traversal for decorator detection (more reliable than regex)
- **Runtime Hooks:** HMR updates applied via `defineComponent.__sfc_applyUpdate`
- **Style Caching:** CSSStyleSheet instances cached by hash for efficient style injection

### Testing

Components are tested manually. Future automated testing could use:
- Puppeteer for browser integration tests
- Component mounting utilities
- Visual regression testing
