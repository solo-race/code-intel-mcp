import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { astGrep, astEdit } from "@oh-my-pi/pi-natives";

const root = ".tmp/ast-smoke";

await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

await writeFile(
  `${root}/sample.ts`,
  `
function demo() {
  console.log("hello");
  console.log("world");
}
`.trimStart(),
);

// 1. structural search
const search = await astGrep({
  patterns: ["console.log($$$ARGS)"],
  path: root,
  limit: 50,
  offset: 0,
  includeMeta: true,
});

console.log("SEARCH");
console.dir(search, { depth: null });

// 2. edit preview — 不写文件
const preview = await astEdit({
  rewrites: {
    "console.log($$$ARGS)": "logger.info($$$ARGS)",
  },
  path: root,
  dryRun: true,
  maxFiles: 50,
  failOnParseError: true,
});

console.log("PREVIEW");
console.dir(preview, { depth: null });

// 确认 dry-run 没有实际修改
console.log("FILE AFTER PREVIEW");
console.log(await readFile(`${root}/sample.ts`, "utf8"));