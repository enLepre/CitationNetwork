/* Topic detection must not block pointer and rendering events. */
importScripts('clusters.js?v=performance-43');
self.onmessage=({data})=>{
  try {self.postMessage({clusters:CitationClusters.detect(data.papers,data.edges,data.seedId)});}
  catch(error){self.postMessage({error:error.message});}
};
