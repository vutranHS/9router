export default {
  id: "muse",
  priority: 60,
  alias: "muse",
  display: {
    name: "Muse AI",
    icon: "brush",
    color: "#7C3AED",
    textIcon: "MU",
    website: "https://muse.ai",
  },
  category: "apikey",
  noAuth: true,
  transport: null,
  models: [
    { id: "default", name: "Muse Image (rotate accounts)", params: ["n"], kind: "image" },
  ],
  serviceKinds: ["image"],
  // Points at the local musegen OpenAI-images shim (muse-farm/server.py).
  // model "muse/default" rotates accounts; add more models (id = account name)
  // to force a specific account. Set MUSE_IMAGE_URL when the shim is not on the
  // gateway's own localhost (e.g. 9router in Docker -> host.docker.internal).
  imageConfig: {
    baseUrl: process.env.MUSE_IMAGE_URL || "http://127.0.0.1:8799/v1/images/generations",
    bodyFields: ["model", "prompt", "n", "size", "quality"],
  },
};
