/* d3-force is bundled locally: no CDN dependency at runtime. */
importScripts('layout.js?v=bonds-13');
self.onmessage = async ({ data }) => {
  // Workers are cancelled by termination; only the main-thread fallback yields.
  try { self.postMessage({ positions: await CitationLayout.layout(data, () => false, false) }); }
  catch (error) { self.postMessage({ error: error.message }); }
};
