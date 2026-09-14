print('@polyengine:{"kind":"header","fileCount":1}');
print('@polyengine:{"kind":"file","file":{"path":"background.json"}}');
setInterval(() => {}, 1_000);
print('@polyengine:{"kind":"done"}');
await globalThis.__polyengineHostEnd();
