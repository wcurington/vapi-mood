const express = require("express");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
const fetch = require("node-fetch");

const app = express();
app.use(bodyParser.json());

// === Google Sheets Setup ===
function getAuth() {
  const base64Key = process.env.GOOGLE_SERVICE_ACCOUNT;
  const jsonKey = JSON.parse(Buffer.from(base64Key, "base64").toString("utf8"));

  return new google.auth.GoogleAuth({
    credentials: jsonKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

const SHEET_ID = process.env.SPREADSHEET_ID; // put your sheet id in env
const CONTACT_SHEET = "Contact List";

// === Endpoint: Trigger Batch Calls ===
app.get("/start-batch", async (req, res) => {
  try {
    const auth = await getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    // 1. Get contact rows
    const range = `${CONTACT_SHEET}!A:C`; // assumes columns: Name | Phone | Status
    const rows = (await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range })).data.values;

    if (!rows) return res.send("No rows found");

    // 2. Filter next 3 with empty status
    const headers = rows[0];
    const dataRows = rows.slice(1);
    const nextThree = dataRows.filter(r => !r[2]).slice(0, 3);

    if (nextThree.length === 0) return res.send("No pending contacts");

    // 3. Send outbound calls to Vapi
    for (let row of nextThree) {
      const [name, phone] = row;
      await fetch("https://api.vapi.ai/calls", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
        },
        body: JSON.stringify({
          phoneNumber: phone,
          webhookUrl: "https://your-render-url.onrender.com/vapi-callback", // replace with Render URL
          metadata: { name },
        }),
      });
    }

    res.send(`Started calls for ${nextThree.map(r => r[0]).join(", ")}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error starting batch");
  }
});

// === Endpoint: Handle Vapi Callbacks ===
app.post("/vapi-callback", async (req, res) => {
  try {
    const { metadata, status } = req.body; // assuming Vapi sends { metadata: {name}, status: "pass/fail" }
    const name = metadata?.name;

    const auth = await getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    // Find the row by name and update Status column (C)
    const range = `${CONTACT_SHEET}!A:C`;
    const rows = (await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range })).data.values;
    const headers = rows[0];
    const dataRows = rows.slice(1);

    let rowIndex = dataRows.findIndex(r => r[0] === name);
    if (rowIndex === -1) throw new Error("Name not found in sheet");

    const updateRange = `${CONTACT_SHEET}!C${rowIndex + 2}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: updateRange,
      valueInputOption: "RAW",
      requestBody: { values: [[status]] },
    });

    res.send("Status updated");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error handling callback");
  }
});

// === Start Server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
