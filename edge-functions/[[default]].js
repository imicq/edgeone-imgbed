export default async function onRequest(context) {
  return new Response(JSON.stringify({ probe: true, url: context.request.url }), { headers: { 'content-type': 'application/json' } });
}
