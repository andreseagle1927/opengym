# Food diary and meal plan

OpenGym stores consumed and planned foods inside the same per-user state that is already synced by `/api/data` and included in JSON backups.

## Features

- Daily diary grouped into breakfast, lunch, dinner, and snacks
- Weekly food-only meal plan with copy-to-tomorrow and idempotent “Log eaten” actions
- Optional calorie, protein, carbohydrate, and fat targets set by the user
- Favorites and custom foods defined per 100 g
- A read-only `GET /api/foods/search?q=...` endpoint

The catalog comes from **USDA FoodData Central SR Legacy, April 2018**. Nutrients are normalized per 100 g of edible portion. Every diary or plan item saves a nutrient snapshot, so later catalog changes do not alter existing records.

Rebuild the catalog from the official CSV archive:

```bash
python3 scripts/build_food_catalog.py FoodData_Central_sr_legacy_food_csv_2018-04.zip api/foods.json
```

Source: <https://fdc.nal.usda.gov/download-datasets/>
