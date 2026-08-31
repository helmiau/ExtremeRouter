// Video provider adapter registry — the video-analog of imageProviders/index.js.
// `getVideoAdapter(provider)` resolves a provider id to its video adapter, or
// null when the provider does not implement text-to-video generation.
import runwayml from "./runwayml.js";

const ADAPTERS = {
  runwayml,
};

export function getVideoAdapter(provider) {
  return ADAPTERS[provider] || null;
}