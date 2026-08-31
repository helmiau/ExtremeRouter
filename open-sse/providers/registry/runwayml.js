export default {
  id: "runwayml",
  priority: 80,
  alias: "runwayml",
  aliases: [
    "runway",
  ],
  uiAlias: "runway",
  display: {
    name: "Runway ML",
    icon: "movie",
    color: "#000000",
    textIcon: "RW",
    website: "https://runwayml.com",
    notice: {
      apiKeyUrl: "https://dev.runwayml.com",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: null,
  models: [
    { id: "gen4_image", name: "Gen-4 Image", params: ["size"], kind: "image" },
    { id: "gen4_image_turbo", name: "Gen-4 Image Turbo", params: ["size"], kind: "image" },
    // Gen-4 Turbo / Gen-3 Alpha Turbo are Image→Video models (image_to_video).
    // They are classified as `image` pipeline models and must NOT be treated as
    // text-to-video targets (they are absent from the current /v1/text_to_video
    // contract). The image adapter still routes them to image_to_video — I2V is
    // preserved unchanged.
    { id: "gen4_turbo", name: "Gen-4 Turbo", params: [], kind: "image" },
    { id: "gen3a_turbo", name: "Gen-3 Alpha Turbo", params: [], kind: "image" },
    // Gen-4.5 is the current verified Text-to-Video model (docs.dev.runwayml.com
    // OpenAPI: POST /v1/text_to_video, gen4.5 requires model/promptText/ratio/
    // duration and does NOT accept promptImage for text-only generation).
    { id: "gen4.5", name: "Gen-4.5", params: ["ratio", "duration"], kind: "video" },
  ],
  serviceKinds: ["image", "video"],
  imageConfig: { baseUrl: "https://api.dev.runwayml.com/v1" },
  videoConfig: {
    baseUrl: "https://api.dev.runwayml.com/v1",
    bodyFields: ["model", "promptText", "ratio", "duration", "seed"],
  },
};
