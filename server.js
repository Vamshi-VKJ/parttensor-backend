const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", function(req, res) {
  res.json({ status: "ok", service: "PartTensor", time: new Date().toISOString() });
});

app.post("/api/chat", async function(req, res) {
  var message = req.body.message;
  if (!message) return res.status(400).json({ error: "Message is required" });

  try {
    const fetch = (await import("node-fetch")).default;
    var aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: "You are PartTensor, a hardware engineering AI. Help engineers find components, design circuits, and answer electronics questions. Be direct and technical.",
        messages: [{ role: "user", content: message }],
      }),
    });
    var aiData = await aiRes.json();
    if (aiData.error) return res.status(503).json({ error: aiData.error.message });
    var text = (aiData.content || []).map(function(b) { return b.text || ""; }).join("");
    res.json({ text: text, mode: "text" });
  } catch (err) {
    res.status(500).json({ error: "Server error: " + err.message });
  }
});

var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log("PartTensor running on port " + PORT);
});
