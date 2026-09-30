// Builder folder tree tab Files (murni, tanpa dependensi).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFileTree, sortedNames } from "../web/src/tree.js";

describe("buildFileTree", () => {
  it("file root tanpa folder", () => {
    const t = buildFileTree([{ path: "README.md", size: 10 }]);
    assert.deepEqual(Object.keys(t.dirs), []);
    assert.equal(t.files.length, 1);
    assert.equal(t.count, 1);
  });
  it("path bersarang jadi folder bertingkat + count", () => {
    const t = buildFileTree([
      { path: "src/a.ts", size: 1 },
      { path: "src/sub/b.ts", size: 2 },
      { path: "README.md", size: 3 },
    ]);
    assert.deepEqual(sortedNames(t.dirs), ["src"]);
    assert.equal(t.dirs.src.files.length, 1);
    assert.equal(t.dirs.src.dirs.sub.files.length, 1);
    assert.equal(t.dirs.src.dirs.sub.path, "src/sub");
    assert.equal(t.count, 3);
    assert.equal(t.dirs.src.count, 2);
    assert.equal(t.files.length, 1);
  });
  it("kosong / rusak → tree kosong tanpa meledak", () => {
    assert.deepEqual(buildFileTree([]).count, 0);
    assert.deepEqual(buildFileTree(null).count, 0);
    assert.deepEqual(buildFileTree([{ path: "" }, null, {}]).count, 0);
  });
  it("sortedNames alfabetis", () => {
    const t = buildFileTree([{ path: "z/f", size: 1 }, { path: "a/f", size: 1 }]);
    assert.deepEqual(sortedNames(t.dirs), ["a", "z"]);
  });
});
