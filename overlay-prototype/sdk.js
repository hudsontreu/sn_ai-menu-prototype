import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Simply print a 1-line poem to the console.",
  options: { allowedTools: ["Read", "Edit"] }
})) {
  console.log(message.text);
}