(() => {
  const MAX_PAYLOAD_SIZE = 1024 * 1024;
  let scriptUrl = null;

  function report(error) {
    const message = error instanceof Error ? error.message : String(error);
    window.parent.postMessage({ type: 'sfc-preview-error', message }, '*');
  }

  window.addEventListener('error', event => report(event.error || event.message));
  window.addEventListener('unhandledrejection', event => report(event.reason));
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.type !== 'sfc-preview-render') return;

    const { template, style, tag, script } = event.data;
    if (![template, style, tag, script].every(value => typeof value === 'string')) return;
    if (template.length + style.length + script.length > MAX_PAYLOAD_SIZE) {
      report('Preview source exceeds the 1 MB sandbox limit.');
      return;
    }
    if (!/^[a-z][\w-]*-[\w-]+$/.test(tag)) {
      report('Preview component tag is invalid.');
      return;
    }

    try {
      if (scriptUrl) URL.revokeObjectURL(scriptUrl);
      document.head.querySelectorAll('style, script[data-preview]').forEach(node => node.remove());
      document.body.replaceChildren(document.createElement(tag));

      const stylesheet = document.createElement('style');
      stylesheet.textContent = `*{box-sizing:border-box}html,body{margin:0;min-height:100%}${style}`;
      document.head.appendChild(stylesheet);

      scriptUrl = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
      const executable = document.createElement('script');
      executable.dataset.preview = '';
      executable.src = scriptUrl;
      executable.onerror = () => report('The compiled preview script could not be loaded.');
      document.head.appendChild(executable);
    } catch (error) {
      report(error);
    }
  });
})();
