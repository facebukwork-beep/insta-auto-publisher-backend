export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/api/health") {
      return Response.json({ ok: true, service: "insta-auto-publisher-cloudflare", version: "15.0.0", scheduler: "cron-every-minute" }, { headers: cors() });
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    return Response.json({ error: "Route not migrated yet" }, { status: 404, headers: cors() });
  },
  async scheduled(controller, env, ctx) {
    console.log("Scheduler tick", new Date(controller.scheduledTime).toISOString());
  }
};

function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization"
  };
}
