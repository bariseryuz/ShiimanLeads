/**
 * Order discovery URLs so API-resolvable links (Hub, Socrata, ArcGIS REST) are tried before /about catalog pages.
 */

function apiLikelihoodScore(url) {
  const u = String(url || '');
  if (/hub\.arcgis\.com\/datasets\/[a-f0-9]{32}/i.test(u)) return 100;
  if (/[0-9a-z]{4}-[0-9a-z]{4}/i.test(u) && /socrata/i.test(u)) return 95;
  if (/[0-9a-z]{4}-[0-9a-z]{4}/i.test(u) && /\/(resource|dataset)\//i.test(u)) return 93;
  if (/featureserver\/\d+|\/mapserver\//i.test(u)) return 90;
  if (/data\.[a-z.]+\.gov\/datasets\/.+\/about/i.test(u)) return 5;
  if (/hub\.arcgis\.com\/maps\//i.test(u)) return 20;
  if (/\/datasets\//i.test(u) && /\/about/i.test(u)) return 10;
  return 40;
}

/**
 * @param {{ url: string, title?: string, snippet?: string, sourceQuery?: string }[]} sources
 */
function sortCandidateSources(sources) {
  return [...sources].sort((a, b) => apiLikelihoodScore(b.url) - apiLikelihoodScore(a.url));
}

/**
 * @param {string[]} urls
 */
function sortUrls(urls) {
  return [...urls].sort((a, b) => apiLikelihoodScore(b) - apiLikelihoodScore(a));
}

module.exports = { sortCandidateSources, sortUrls, apiLikelihoodScore };
