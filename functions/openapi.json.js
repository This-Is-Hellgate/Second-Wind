import { buildOpenApi, discoveryJson } from "./_lib/discovery.js";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  return discoveryJson(await buildOpenApi(context.env, `${url.protocol}//${url.host}`));
}
