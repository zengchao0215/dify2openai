import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";
dotenv.config();

if (!process.env.DIFY_API_URL) throw new Error("DIFY API URL is required.");

const app = express();
app.use(bodyParser.json());

app.post("/v1/chat/completions", async (req, res) => {
  const authHeader =
    req.headers["authorization"] || req.headers["Authorization"];
  if (!authHeader) {
    return res.status(401).json({
      code: 401,
      errmsg: "Unauthorized.",
    });
  } else {
    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({
        code: 401,
        errmsg: "Unauthorized.",
      });
    }
  }
  try {
    const data = req.body;
    const queryString = data.messages[data.messages.length - 1].content;
    const stream = data.stream !== undefined ? data.stream : false;
    const resp = await fetch(process.env.DIFY_API_URL + "/chat-messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authHeader.split(" ")[1]}`,
      },
      body: JSON.stringify({
        inputs: {},
        query: queryString,
        response_mode: "streaming",
        conversation_id: "",
        user: "apiuser",
      }),
    });
    console.log("Received response from DIFY API with status:", resp.status);
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      const stream = resp.body;
      let buffer = "";

      stream.on("data", (chunk) => {
        buffer += chunk.toString();
        let lines = buffer.split("\n");

        for (let i = 0; i < lines.length - 1; i++) {
          let line = lines[i].trim();

          if (!line.startsWith("data:")) continue;
          line = line.slice(5).trim();
          let chunkObj;
          try {
            if (line.startsWith("{")) {
              chunkObj = JSON.parse(line);
            } else {
              continue;
            }
          } catch (error) {
            console.error("Error parsing chunk:", error);
            continue;
          }

          if (chunkObj.event === "message") {
            const chunkContent = JSON.parse(
              `"${chunkObj.answer.replace(
                /[\u0000-\u001F\u007F-\u009F]/g,
                ""
              )}"`
            );
            const chunkId = `chatcmpl-${Date.now()}`;
            const chunkCreated = chunkObj.created_at;
            res.write(
              "data: " +
                JSON.stringify({
                  id: chunkId,
                  object: "chat.completion.chunk",
                  created: chunkCreated,
                  model: data.model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        content: chunkContent,
                      },
                      finish_reason: null,
                    },
                  ],
                }) +
                "\n\n"
            );
          } else if (chunkObj.event === "agent_message") {
            const chunkContent = chunkObj.answer;
            const chunkId = `chatcmpl-${Date.now()}`;
            const chunkCreated = chunkObj.created_at;
            res.write(
              "data: " +
                JSON.stringify({
                  id: chunkId,
                  object: "chat.completion.chunk",
                  created: chunkCreated,
                  model: data.model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        content: chunkContent,
                      },
                      finish_reason: null,
                    },
                  ],
                }) +
                "\n\n"
            );
          } else if (chunkObj.event === "message_end") {
            const chunkId = `chatcmpl-${Date.now()}`;
            const chunkCreated = chunkObj.created_at;
            res.write(
              "data: " +
                JSON.stringify({
                  id: chunkId,
                  object: "chat.completion.chunk",
                  created: chunkCreated,
                  model: data.model,
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason: "stop",
                    },
                  ],
                }) +
                "\n\n"
            );
            res.write("data: [DONE]\n\n");
            res.end();
          } else if (chunkObj.event === "agent_thought") {
          } else if (chunkObj.event === "ping") {
          } else if (chunkObj.event === "error") {
            console.error(`Error: ${chunkObj.code}, ${chunkObj.message}`);
            res
              .status(500)
              .write(
                `data: ${JSON.stringify({ error: chunkObj.message })}\n\n`
              );
            res.write("data: [DONE]\n\n");
            res.end();
          }
        }

        buffer = lines[lines.length - 1];
      });
    } else {
      let result = "";
      let hasError = false;
      let messageEnded = false;
      let buffer = "";

      const stream = resp.body;
      stream.on("data", (chunk) => {
        buffer += chunk.toString();
        let lines = buffer.split("\n");

        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          if (line === "") continue;
          let chunkObj;
          try {
            const cleanedLine = line.replace(/^data: /, "").trim();
            if (cleanedLine.startsWith("{") && cleanedLine.endsWith("}")) {
              chunkObj = JSON.parse(cleanedLine);
            } else {
              continue;
            }
          } catch (error) {
            console.error("Error parsing JSON:", error);
            continue;
          }

          if (
            chunkObj.event === "message" ||
            chunkObj.event === "agent_message"
          ) {
            result += chunkObj.answer.trim();
          } else if (chunkObj.event === "message_end") {
            messageEnded = true;
          } else if (chunkObj.event === "agent_thought") {
          } else if (chunkObj.event === "ping") {
          } else if (chunkObj.event === "error") {
            console.error(`Error: ${chunkObj.code}, ${chunkObj.message}`);
            hasError = true;
            break;
          } else {
            console.warn(`Unknown event type: ${chunkObj.event}`);
          }
        }

        buffer = lines[lines.length - 1];
      });

      stream.on("end", () => {
        if (hasError) {
          res
            .status(500)
            .json({ error: "An error occurred while processing the request." });
        } else if (messageEnded) {
          res.json({
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion",
            created: Date.now(),
            model: data.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: result.trim(),
                },
                finish_reason: "stop",
              },
            ],
          });
        } else {
          res.status(500).json({ error: "Unexpected end of stream." });
        }
      });
    }
  } catch (error) {
    console.error("Error:", error);
  }
});

app.listen(process.env.PORT || 3000);
