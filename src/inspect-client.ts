import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
console.log("Client prototype methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(client)).filter(n => !n.startsWith("_")).sort());
console.log("Client own props:", Object.getOwnPropertyNames(client).sort());
// Check if request exists
console.log("client.request type:", typeof (client as any).request);
console.log("client.request length:", (client as any).request?.length);
if ((client as any).request) {
  console.log("request toString:", (client as any).request.toString().slice(0, 500));
}
// Check Protocol base
import { Protocol } from "@modelcontextprotocol/client";
console.log("Protocol prototype:", Object.getOwnPropertyNames(Protocol.prototype).filter(n => !n.startsWith("_")).sort());
