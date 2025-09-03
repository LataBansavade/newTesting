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

// // Upload endpoint
// app.post("/analyze-image", upload.array("images"), async (req, res) => {
//   try {
//     if (!req.files || req.files.length === 0) {
//       return res.status(400).json({ error: "No images uploaded" });
//     }

//     const results = [];
//     for (const file of req.files) {
//       const imagePath = file.path;
//       const imageBase64 = fs.readFileSync(imagePath, { encoding: "base64" });

//       // Send to OpenAI Vision (GPT-5) for menu card OCR and structured extraction
//       const response = await client.chat.completions.create({
//         model: "gpt-5",
//         messages: [
//           {
//             role: "user",
//             content: [
//               {
//                 type: "text",
//                 text: `You are an expert at reading and extracting information from images of menu cards. The user has uploaded a photo of a menu card. Your tasks are:\n1. Accurately read and extract all visible text from the menu card image (perform OCR).\n2. Structure the extracted menu items in a clear JSON array format, where each object contains:\n   - item_name\n   - description (if available)\n   - price (if available)\n   - category (if visible, e.g., Drinks, Starters, Main Course, etc.)\n   - glassware_type (if a specific glass is shown for this item, e.g., tumbler, wine glass, pint glass, cocktail glass, etc.; otherwise null)\n3. If the image is unclear or text is unreadable, mention which parts could not be read.\n4. Do not add or guess any items that are not visible in the image.\nReturn only the JSON array of menu items, and if there are any unreadable sections, include a key unreadable_sections with a description. For each menu item, glassware_type should be a property of the item object, not a separate key.`
//               },
//               {
//                 type: "image_url",
//                 image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
//               },
//             ],
//           },
//         ],
//         response_format: { type: "json_object" },
//       });

//       // Delete uploaded file to save space
//       fs.unlinkSync(imagePath);

//       // Return the structured menu extraction result
//       let result;
//       try {
//         result = JSON.parse(response.choices[0].message.content);
//       } catch (e) {
//         // fallback: return raw content if not valid JSON
//         result = { raw: response.choices[0].message.content };
//       }
//       results.push(result);
//     }
//     res.json({ results });
//   } catch (err) {
//     console.error("Error analyzing image:", err);
//     res.status(500).json({ error: "Failed to analyze image" });
//   }
// });


// app.post("/match-drinks", upload.single("image"), async (req, res) => {
//   try {
//     if (!req.file) return res.status(400).json({ error: "No image uploaded" });

//     const filters = req.body; // expects JSON with filter options
//     const imagePath = req.file.path;
//     const imageBase64 = fs.readFileSync(imagePath, { encoding: "base64" });

//     const response = await client.chat.completions.create({
//       model: "gpt-4o-mini",
//       messages: [
//         {
//           role: "user",
//           content: [
//             {
//               type: "text",
//               text: `You are a drinks expert. 
// The user uploaded an image of a drink. 
// Also, they provided filter preferences: 
// ${JSON.stringify(filters, null, 2)}

// Task:
// 1. Analyze the image.
// 2. Suggest at least 3 possible drink matches that best fit both the image AND the filter options.
// 3. Return the result strictly in JSON array format, where each object has keys:
//    - "name"
//    - "description"
//    - "alcohol_type"
//    - "strength"
//    - "glassware"
//    - "acidity"
//    - "sweetness"
//    - "bitterness"
//    - "spice"
//    - "match_score" (0-100, % how well it matches filters)`,
//             },
//             {
//               type: "image_url",
//               image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
//             },
//           ],
//         },
//       ],
//       response_format: { type: "json_object" }, // enforce JSON
//     });

//     fs.unlinkSync(imagePath);

//     const matches = JSON.parse(response.choices[0].message.content);

//     res.json({
//       matches: matches,
//     });
//   } catch (err) {
//     console.error("Error matching drinks:", err);
//     res.status(500).json({ error: "Failed to match drinks" });
//   }
// });

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
