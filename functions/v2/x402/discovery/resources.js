import { buildX402Resources, discoveryJson } from "../../../_lib/discovery.js";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  return discoveryJson(await buildX402Resources(context.env, `${url.protocol}//${url.host}`));
}
