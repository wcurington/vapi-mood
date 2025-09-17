const express = require("express");
const bodyParser = require("body-parser");
const { google } = require("googleapis");

const app = express();
app.use(bodyParser.json());

// === Default route for sanity check ===
app.get("/", (req, res) => {
  res.send("✅ Vapi Webhook is running! Use /start-batch or trigger from Google Sheets.");
});

// === Google Sheets Setup ===
function getAuth() {
  const base64Key = process.env.GOOGLE_SERVICE_ACCOUNT;
  const jsonKey = JSON.parse(Buffer.from(base64Key, "base64").toString("utf8"));

  return new google.auth.GoogleAuth({
    credentials: jsonKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

const SHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = "outbound_list"; // 👈 must match your tab name exactly

// === Vapi IDs (provided) ===
const ASSISTANT_ID = "assistant-17df5a21-f369-40ce-af33-0beab6683f21";
const PHONE_NUMBER_ID = "phone number-f9ecb3f9-b02f-4263-bf9d-2993456f451f";

// === Apps Script URL (for logging callbacks) ===
const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwLspnRCCJ--LQQR3IuMfpI0PgUr6aialt2AJ3t1-OUmgdZQJVukNul9Lodmz98enY5og/exec";

// === Endpoint: Trigger Batch Calls ===
app.get("/start-batch", async (req, res) => {
  try {
    const auth = await getAuth();

    // Log service account info
    const client = await auth.getClient();
    const projectId = await auth.getProjectId();
    console.log("Using service account:", client.email, "Project:", projectId);

    const sheets = google.sheets({ version: "v4", auth });

    // 1. Get all rows
    const range = `${SHEET_NAME}!A:I`;
    console.log("Fetching from sheet:", SHEET_ID, "tab:", SHEET_NAME, "range:", range);

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range,
    });

    const rows = response.data.values;
    if (!rows || rows.length < 2) return res.send("No rows found");

    const headers = rows[0];
    const dataRows = rows.slice(1);

    // Map header indices
    const idIdx = headers.indexOf("id");
    const phoneIdx = headers.indexOf("phone");
    const statusIdx = headers.indexOf("status");

    // 2. Filter next 3 contacts with empty or pending status
    const nextThree = dataRows
      .map((row, i) => ({ row, i }))
      .filter(
        (r) =>
          !r.row[statusIdx] ||
          r.row[statusIdx].toLowerCase() === "pending"
      )
      .slice(0, 3);

    if (nextThree.length === 0) return res.send("No pending contacts");

    // 3. Start Vapi calls + collect responses
    const results = [];

    for (let entry of nextThree) {
      const row = entry.row;
      const rowIndex = entry.i + 2; // +2 for header row + 1-based index
      const id = row[idIdx];
      const phone = row[phoneIdx];

      if (!phone) {
        console.warn(`⚠️ Skipping id=${id} (no phone number)`);
        results.push({ id, phone, error: "No phone number" });
        continue;
      }

      console.log(`📞 Starting call for id=${id}, phone=${phone}`);

      const payload = {
  assistantId: "17df5a21-f369-40ce-af33-0beab6683f21", // UUID only
  phoneNumberId: "f9ecb3f9-b02f-4263-bf9d-2993456f451f", // UUID only
  customer: { number: phone }, // must be in +E.164 format
  metadata: { id, rowIndex }   // still fine, gets echoed in callback
};

      console.log("Sending to Vapi:", payload);

      const vapiResp = await fetch("https://api.vapi.ai/call", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
        },
        body: JSON.stringify(payload),
      });

      const vapiResultText = await vapiResp.text();
      console.log("Vapi response:", vapiResultText);

      let vapiJson;
      try {
        vapiJson = JSON.parse(vapiResultText);
      } catch {
        vapiJson = { raw: vapiResultText };
      }

      results.push({ id, phone, response: vapiJson });
    }

    // ✅ Return results
    res.json({ started: results });
  } catch (err) {
    console.error("Batch error object:", err);

    if (err.response && err.response.data) {
      res
        .status(500)
        .send("Error starting batch: " + JSON.stringify(err.response.data));
    } else if (err.message) {
      res.status(500).send("Error starting batch: " + err.message);
    } else {
      res.status(500).send("Error starting batch: " + JSON.stringify(err));
    }
  }
});

// === Endpoint: Handle Vapi Callbacks ===
app.post("/vapi-callback", async (req, res) => {
  try {
    console.log("📩 Incoming Vapi callback:", JSON.stringify(req.body, null, 2));

    const { metadata, status, result } = req.body;
    const id = metadata?.id;
    const rowIndex = metadata?.rowIndex;
    const timestamp = new Date().toISOString();

    if (!id || !rowIndex) {
      throw new Error("Missing metadata.id or rowIndex in callback");
    }

    const auth = await getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    // Get header indices
    const headerResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1:I1`,
    });
    const headers = headerResp.data.values[0];

    const statusIdx = headers.indexOf("status") + 1;
    const attemptsIdx = headers.indexOf("attempts") + 1;
    const lastAttemptIdx = headers.indexOf("lastAttemptAt") + 1;
    const resultIdx = headers.indexOf("result") + 1;

    // Read current attempts
    const attemptsCell = `${SHEET_NAME}!${String.fromCharCode(64 + attemptsIdx)}${rowIndex}`;
    const currentAttemptsResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: attemptsCell,
    });
    const currentAttempts =
      parseInt(currentAttemptsResp.data.values?.[0]?.[0] || "0", 10);

    // Prepare updates
    const updates = [
      {
        range: `${SHEET_NAME}!${String.fromCharCode(64 + statusIdx)}${rowIndex}`,
        values: [[status || "completed"]],
      },
      {
        range: attemptsCell,
        values: [[currentAttempts + 1]],
      },
      {
        range: `${SHEET_NAME}!${String.fromCharCode(64 + lastAttemptIdx)}${rowIndex}`,
        values: [[timestamp]],
      },
      {
        range: `${SHEET_NAME}!${String.fromCharCode(64 + resultIdx)}${rowIndex}`,
        values: [[result || ""]],
      },
    ];

    // Batch update to Google Sheet
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        valueInputOption: "RAW",
        data: updates,
      },
    });

    console.log(`✅ Updated row ${rowIndex} for id=${id}`);

    // === Forward callback to Apps Script logger ===
    try {
      await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
      });
      console.log("📤 Forwarded callback to Apps Script");
    } catch (forwardErr) {
      console.error("⚠️ Failed to forward callback to Apps Script:", forwardErr);
    }

    res.send("Row updated + callback forwarded");
  } catch (err) {
    console.error("Callback error:", err);
    res.status(500).send("Error handling callback: " + err.message);
  }
});

// === Start Server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
