// server.js
import express from "express";
import multer from "multer";
import fs from "fs";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const upload = multer({ dest: "uploads/" });
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPEN_AI_KEY, // set in .env
});


/**
 * Normalize values for fuzzy matching
 */
function normalizeValue(value) {
  if (!value) return "";
  const v = value.toLowerCase().trim();

  // Strength normalization
  if (["very strong", "extra strong", "strong", "high"].includes(v)) return "high";
  if (["medium", "normal"].includes(v)) return "medium";
  if (["light", "low", "mild", "weak"].includes(v)) return "low";

  // Spice normalization
  if (["no", "none", "zero"].includes(v)) return "low";

  return v;
}

/**
 * Function to calculate how well a drink matches preferences
 */
function calculateMatch(drink, filters) {
  let score = 0;

  // Alcohol type
  if (
    filters.alcohol_type &&
    normalizeValue(drink.alcohol_type) === normalizeValue(filters.alcohol_type)
  ) {
    score += 30;
  }

  // Strength
  if (
    filters.strength &&
    normalizeValue(drink.strength) === normalizeValue(filters.strength)
  ) {
    score += 20;
  }

  // Glassware (fuzzy includes check)
  if (
    filters.glassware &&
    drink.glassware?.toLowerCase().includes(filters.glassware.toLowerCase())
  ) {
    score += 15;
  }

  // Sweetness
  if (
    filters.sweetness &&
    normalizeValue(drink.sweetness) === normalizeValue(filters.sweetness)
  ) {
    score += 10;
  }

  // Bitterness
  if (
    filters.bitterness &&
    normalizeValue(drink.bitterness) === normalizeValue(filters.bitterness)
  ) {
    score += 10;
  }

  // Acidity
  if (
    filters.acidity &&
    normalizeValue(drink.acidity) === normalizeValue(filters.acidity)
  ) {
    score += 10;
  }

  // Spice
  if (
    filters.spice &&
    normalizeValue(drink.spice) === normalizeValue(filters.spice)
  ) {
    score += 5;
  }

  return score;
}

/**
 * Route: Upload menu card image + preferences
 */
app.post("/match-drinks", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });

    const filters = req.body;
    const imagePath = req.file.path;
    const imageBase64 = fs.readFileSync(imagePath, { encoding: "base64" });

    // Step 1: Extract menu items using GPT
    const extraction = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `You are an expert OCR + Drinks classifier.
The user uploaded a menu card image.
Task:
Return strictly a JSON array (no object wrapper). Each element must have:
- "name"
- "description"
- "alcohol_type"
- "strength"
- "glassware"
- "acidity"
- "sweetness"
- "bitterness"
- "spice"`,
            },
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
            },
          ],
        },
      ],
    });

    fs.unlinkSync(imagePath);

    let rawContent = extraction.choices[0].message.content.trim();
    if (rawContent.startsWith("```")) {
      rawContent = rawContent.replace(/^```[a-z]*\n?/, "").replace(/```$/, "");
    }

    let drinks;
    try {
      drinks = JSON.parse(rawContent);
    } catch (e) {
      console.error("Failed to parse GPT JSON:", rawContent);
      return res.status(500).json({ error: "Invalid AI response format" });
    }

    if (!Array.isArray(drinks)) {
      return res.status(500).json({ error: "Invalid AI extraction format" });
    }

    // Step 2: Score drinks
    const scoredDrinks = drinks
      .map(drink => ({
        ...drink,
        match_score: calculateMatch(drink, filters),
      }))
      .filter(d => d.match_score > 0) // remove items with 0 score
      .sort((a, b) => b.match_score - a.match_score);

    return res.json({ matches: scoredDrinks });

  } catch (err) {
    console.error("Error matching drinks:", err);
    res.status(500).json({ error: "Failed to match drinks" });
  }
});

app.listen(5000, () => {
  console.log("🚀 Server running on http://localhost:5000");
});


// type of alcohol: whiskey ,gin,brandy ,rum ,vodka,tequila,liqueur,cognac,absinthe,mezcal,sake,soju,wine,beer,cider,non-alcoholic
// type of glassware: rocks glass,coupe,highball glass,cocktail glass,champagne flute,beer mug,shot glass,brandy snifter,collins glass,martini glass,whiskey tumbler,something unique
// strength of alcohol: weak,medium,strong,
// sweetness : low , medium , high
// Bitterness : low , medium , high
// Acidity : low , medium , high
// spice level : low , medium , high 
