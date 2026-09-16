import { extractText, getDocumentProxy } from "unpdf";
import fs from "fs";

const data = new Uint8Array(fs.readFileSync("/tmp/cv1.pdf"));
console.log("File size:", data.length, "bytes");

const pdf = await getDocumentProxy(data);
const { text, totalPages } = await extractText(pdf, { mergePages: true });

console.log("Pages:", totalPages);
console.log("Text length:", text.length, "chars");
console.log("\n--- First 1000 chars ---");
console.log(text.slice(0, 1000));
