// Folder tree untuk tab Files panel review (murni, tanpa dependensi).
// Dipakai web (App.svelte); dites di test/tree.test.ts.
// Bentuk node: { name, path, dirs: {nama: node}, files: [{path,size}], count }
export function buildFileTree(files) {
  const root = { name: "", path: "", dirs: {}, files: [], count: 0 };
  for (const f of files || []) {
    if (!f || typeof f.path !== "string" || !f.path) continue;
    const parts = f.path.split("/").filter(Boolean);
    if (!parts.length) continue;
    let node = root;
    node.count++;
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      if (!node.dirs[parts[i]]) {
        node.dirs[parts[i]] = { name: parts[i], path: prefix, dirs: {}, files: [], count: 0 };
      }
      node = node.dirs[parts[i]];
      node.count++;
    }
    node.files.push(f);
  }
  return root;
}

/** Nama folder/file terurut (folder dulu bila diminta dua daftar terpisah). */
export function sortedNames(dirs) {
  return Object.keys(dirs || {}).sort();
}
