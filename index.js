

import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const upload = multer({ dest: "uploads/" });
app.use(express.json());

const client = new OpenAI({ apiKey: process.env.OPEN_AI_KEY });

// -----------------------------
// JSON Schema (Structured Outputs)
// -----------------------------
const drinkItemSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    price: { type: ["string","null"] },
    alcohol_type: { type: "string" },
    strength: { type: "string" },
    glassware: { type: "string" },
    acidity: { type: "string" },
    sweetness: { type: "string" },
    bitterness: { type: "string" },
    spice: { type: "string" },
    ingredients: { type: "array", items: { type: "string" } },
    match_percentage: { type: "integer" },
    field_scores: {
      type: "object",
      properties: {
        alcohol_type: { type: "integer" },
        strength: { type: "integer" },
        glassware: { type: "integer" },
        acidity: { type: "integer" },
        sweetness: { type: "integer" },
        bitterness: { type: "integer" },
        spice: { type: "integer" }
      },
      required: ["alcohol_type","strength","glassware","acidity","sweetness","bitterness","spice"]
    },
    reasoning: { type: "string" },
    assumptions: { type: ["string","null"] }
  },
  required: ["name","alcohol_type","strength","glassware","acidity","sweetness","bitterness","spice","match_percentage","field_scores"]
};

const drinksArraySchema = {
  name: "drinks_response",
  strict: true,
  schema: {
    type: "object",
    properties: {
      preference: { type: "object" },
      drinks: { type: "array", items: drinkItemSchema },
      sorted_by: { type: "string" },
      notes: { type: "string" }
    },
    required: ["preference","drinks","sorted_by"]
  }
};

// -----------------------------
// System Prompt (GPT-5 Agent)
// -----------------------------
const SYSTEM_PROMPT = `


ROLE : you are a drink-recommender expert. Given user preferences and a list of drinks, you need to find the best matches.
 parse menu_images (OCR/vision) + a user preference profile.
Return only strict JSON with drinks scored 0–100. Never invent items.

INPUTS
preference fields:
- alcohol_type (Whiskey,Vodka,Gin,Rum,Tequila,Brandy,Pisco,Wine,Beer,NA)
- strength (Very strong|Strong|Medium|Low|NA)
- glassware (Highball|Lowball|Coupe|Martini|Rocks|Nick&Nora|Collins|Flute|Wine|Mug|Any)
- acidity (High|Medium|Low|None/NA)
- sweetness (High|Medium|Low|Dry|None/NA)
- bitterness (High|Medium|Low|None/NA)
- spice (Yes|No|Mild|NA)

SCORING
Weights: Alcohol 40, Strength 20, Glassware 10, Acidity 10, Sweetness 8, Bitterness 8, Spice 4.
Rules:
- Pref = Any/NA → full credit.
- Exact = full points, Adjacent = half points.
- If missing, infer conservatively (lime/lemon → high acidity; cream/amaretto → high sweetness; dry vermouth → dry/bitter). If not obvious, give half credit + note.
- Never invent attributes.

NORMALIZATION
Glassware: Highball≈Collins, Lowball≈Rocks/OF, Coupe≈Nick&Nora (near), Martini≈Cocktail glass.
Strength: Very strong=all alcohol; Strong=spirit-led+small modifier; Medium=spirit+mixer; Low=mostly mixer.
Flavor: Citrus=acidic; Cream/liqueur=sweet; Bitters/vermouth=bitterness.

OUTPUT JSON
{
 "preference": { normalized prefs },
 "drinks":[
   {
    "name":"string","price":"string|null",
    "alcohol_type":"string","strength":"...","glassware":"...","acidity":"...","sweetness":"...","bitterness":"...","spice":"...",
    "ingredients":["..."],
    "match_percentage":0–100,
    "field_scores":{"alcohol_type":0,"strength":0,"glassware":0,"acidity":0,"sweetness":0,"bitterness":0,"spice":0},
    "reasoning":"1–2 sentences",
    "assumptions":"null|notes"
   }
 ],
 "sorted_by":"match_percentage",
 "notes":"global assumptions or parsing notes"
}

PROCEDURE
1. Extract drinks from all pages.
2. Normalize attributes with alias rules.
3. Score per field → sum → match_percentage.
4. Sort by match_percentage desc (ties alphabetical).
5. Return max 30 drinks; if truncated add note.

EDGE CASES
- Unreadable fields → assumptions.
- image quality issues → note.
- not able to parse image → error.
- Missing pref → treat as NA.
- If no matches for alcohol_type → return best cross-type + note.

STRICTNESS
- JSON only, no markdown or chatter.
- Never output items not in images.

EXAMPLE
Pref: {"alcohol_type":"Whiskey","strength":"Very strong","glassware":"Highball","acidity":"Low","sweetness":"Medium","bitterness":"Medium","spice":"No"}
Output excerpt:
{
 "preference":{...},
 "drinks":[
   {"name":"Manhattan Perfect","alcohol_type":"Whiskey","strength":"Very strong","glassware":"Martini (near Highball=partial)","acidity":"Low","sweetness":"Low-Medium","bitterness":"Medium","spice":"No","ingredients":["whiskey","vermouth","angostura"],"match_percentage":92,"field_scores":{"alcohol_type":40,"strength":20,"glassware":5,"acidity":10,"sweetness":4,"bitterness":8,"spice":4},"reasoning":"Spirit-forward whiskey drink; glassware mismatch.","assumptions":null}
 ],
 "sorted_by":"match_percentage",
 "notes":"Glassware alias rules applied."
}
`;


// -----------------------------
// API Route
// -----------------------------
app.post("/match-drinks", upload.array("images", 10), async (req, res) => {
  try {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: "No images uploaded" });

    const prefs = req.body || {};

    // Process each image separately to avoid context window limitations
    let allDrinks = [];
    let processingNotes = [];
    
    // Process images sequentially to avoid rate limiting
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const imgB64 = fs.readFileSync(file.path, { encoding: "base64" });
        
        // Create a prompt for each image
        const promptText = `
User preference (JSON):
${JSON.stringify(prefs, null, 2)}

Please analyze this menu image and recommend drinks based on these preferences.
Use the system prompt guidance for scoring and normalization.
This is image ${i+1} of ${files.length}.
`;

        // Create the chat completion request with GPT-4o
        const messages = [
          { role: "system", content: SYSTEM_PROMPT },
          { 
            role: "user", 
            content: [
              { type: "text", text: promptText },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${imgB64}`
                }
              }
            ]
          }
        ];

        // Process this image
        const completion = await client.chat.completions.create({
          model: "gpt-4o",
          messages: messages,
          response_format: { type: "json_object" }
        });

        // Parse response for this image
        const responseText = completion.choices[0].message.content;
        const imageResult = JSON.parse(responseText);
        
        if (imageResult.drinks && Array.isArray(imageResult.drinks)) {
          // Add image number to each drink for tracking
          imageResult.drinks.forEach(drink => {
            drink.source_image = i + 1;
          });
          
          // Add these drinks to our collection
          allDrinks = allDrinks.concat(imageResult.drinks);
          
          // Collect processing notes
          if (imageResult.notes) {
            processingNotes.push(`Image ${i+1}: ${imageResult.notes}`);
          }
        }
        
        console.log(`Processed image ${i+1}/${files.length}: found ${imageResult.drinks?.length || 0} drinks`);
        
      } catch (error) {
        console.error(`Error processing image ${i+1}:`, error);
        processingNotes.push(`Image ${i+1}: Processing failed - ${error.message}`);
      }
    }

    // Clean up uploaded files after processing
    for (const f of files) {
      try { fs.unlinkSync(f.path); } catch {}
    }

    // If we have results, combine and sort them
    if (allDrinks.length > 0) {
      // Remove duplicates (same drink name)
      const uniqueDrinks = [];
      const drinkNames = new Set();
      
      allDrinks.forEach(drink => {
        if (!drinkNames.has(drink.name.toLowerCase())) {
          drinkNames.add(drink.name.toLowerCase());
          uniqueDrinks.push(drink);
        }
      });
      
      // Sort by match percentage
      uniqueDrinks.sort((a, b) => {
        const scoreA = typeof a.match_percentage === 'number' ? a.match_percentage : 0;
        const scoreB = typeof b.match_percentage === 'number' ? b.match_percentage : 0;
        return scoreB - scoreA;
      });
      
      // Limit to top 30 drinks if there are more
      const finalDrinks = uniqueDrinks.slice(0, 30);
      
      // Construct the final response
      const result = {
        status: "ok",
        preference: prefs,
        drinks: finalDrinks,
        sorted_by: "match_percentage (enforced)",
        notes: processingNotes.join(' | '),
        diagnostics: {
          images_processed: files.length,
          total_drinks_found: allDrinks.length,
          unique_drinks: uniqueDrinks.length,
          drinks_shown: finalDrinks.length
        }
      };
      
      return res.json(result);
    } else {
      return res.status(422).json({
        error: "Could not extract any drinks from the uploaded images.",
        notes: processingNotes.join(' | ')
      });
    }

  } catch (err) {
    console.error("Error matching drinks:", err);
    res.status(500).json({ error: "Failed to match drinks" });
  }
});

// Add a helper function to normalize strength values consistently
function normalizeStrengthValue(value) {
  if (!value) return "Medium";
  const v = String(value).toLowerCase().trim();
  
  if (["very strong", "extra strong", "boozy", "spirit-forward"].includes(v)) 
    return "Very strong";
  if (["strong", "high"].includes(v)) 
    return "Strong";
  if (["medium", "normal", "moderate"].includes(v)) 
    return "Medium";
  if (["weak", "light", "low", "mild"].includes(v)) 
    return "Low";
  
  return v.charAt(0).toUpperCase() + v.slice(1); // Capitalize first letter
}

// Add a function to standardize preferences display
function standardizePreferences(prefs) {
  const standardized = {...prefs};
  
  // Standardize alcohol_type capitalization
  if (standardized.alcohol_type) {
    standardized.alcohol_type = standardized.alcohol_type.charAt(0).toUpperCase() + 
                               standardized.alcohol_type.slice(1).toLowerCase();
  }
  
  // Standardize strength values
  if (standardized.strength) {
    standardized.strength = normalizeStrengthValue(standardized.strength);
  }
  
  // Standardize other attributes (capitalize first letter)
  const textFields = ['glassware', 'acidity', 'sweetness', 'bitterness', 'spice'];
  textFields.forEach(field => {
    if (standardized[field]) {
      standardized[field] = standardized[field].charAt(0).toUpperCase() + 
                           standardized[field].slice(1).toLowerCase();
    }
  });
  
  return standardized;
}

// Enhance the score validation to be more accurate
function validateScores(drink) {
  // Ensure all scores are within range 0-100
  if (drink.field_scores) {
    Object.keys(drink.field_scores).forEach(key => {
      const score = drink.field_scores[key];
      if (typeof score !== 'number' || isNaN(score) || score < 0) {
        drink.field_scores[key] = 0;
      } else if (score > 100) {
        drink.field_scores[key] = 100;
      } else {
        drink.field_scores[key] = Math.round(score); // Ensure integer scores
      }
    });
  }
  
  // Ensure match_percentage is calculated correctly (sum of weighted scores)
  const weights = {
    alcohol_type: 0.40,
    strength: 0.20,
    glassware: 0.10,
    acidity: 0.10,
    sweetness: 0.08,
    bitterness: 0.08,
    spice: 0.04
  };
  
  let totalScore = 0;
  if (drink.field_scores) {
    Object.entries(weights).forEach(([key, weight]) => {
      if (typeof drink.field_scores[key] === 'number') {
        totalScore += (drink.field_scores[key] / 100) * weight * 100;
      }
    });
  }
  
  // Round to 1 decimal place
  drink.match_percentage = Math.round(totalScore * 10) / 10;
  
  return drink;
}



app.listen(5000, () => {
  console.log("🚀 Drinks Recommender Agent running at http://localhost:5000");
});
