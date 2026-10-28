#!/usr/bin/env python3
"""Build the compact OpenGym catalog from the official USDA SR Legacy CSV zip."""
import csv
import io
import json
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

if len(sys.argv) != 3:
    raise SystemExit("usage: build_food_catalog.py USDA_SR_LEGACY.zip api/foods.json")

archive, output = Path(sys.argv[1]), Path(sys.argv[2])

with zipfile.ZipFile(archive) as zf:
    names = zf.namelist()
    def table(name):
        match = next(n for n in names if n.endswith('/' + name) or n == name)
        return csv.DictReader(io.TextIOWrapper(zf.open(match), encoding='utf-8-sig', newline=''))

    categories = {row['id']: row['description'] for row in table('food_category.csv')}
    foods = {row['fdc_id']: {
        'id': 'usda-' + row['fdc_id'],
        'name': row['description'].strip().title(),
        'category': categories.get(row.get('food_category_id', ''), ''),
        'n': {}
    } for row in table('food.csv')}

    nutrient_keys = {}
    for row in table('nutrient.csv'):
        name, unit = row['name'].lower(), row['unit_name'].lower()
        key = None
        if name == 'protein': key = 'protein'
        elif name == 'carbohydrate, by difference': key = 'carbs'
        elif name == 'total lipid (fat)': key = 'fat'
        elif name == 'energy' and unit == 'kcal': key = 'kcal'
        if key: nutrient_keys[row['id']] = key

    for row in table('food_nutrient.csv'):
        key = nutrient_keys.get(row['nutrient_id'])
        food = foods.get(row['fdc_id'])
        if key and food and key not in food['n']:
            try: food['n'][key] = round(float(row['amount']), 1)
            except (TypeError, ValueError): pass

    portions = defaultdict(list)
    for row in table('food_portion.csv'):
        try: grams = round(float(row['gram_weight']), 1)
        except (TypeError, ValueError): continue
        if grams <= 0 or len(portions[row['fdc_id']]) >= 6: continue
        label = (row.get('portion_description') or row.get('modifier') or '').strip()
        if not label: continue
        amount = row.get('amount', '').strip()
        if amount and amount != '1.0' and not label.startswith(amount): label = f"{amount} {label}"
        portions[row['fdc_id']].append({'label': label[:80], 'grams': grams})

catalog = []
for fdc_id, food in foods.items():
    if 'kcal' not in food['n']: continue
    for key in ('protein', 'carbs', 'fat'): food['n'].setdefault(key, 0)
    if portions[fdc_id]: food['portions'] = portions[fdc_id]
    catalog.append(food)
catalog.sort(key=lambda food: food['name'])

payload = {
    'source': 'USDA FoodData Central SR Legacy',
    'sourceUrl': 'https://fdc.nal.usda.gov/download-datasets/',
    'version': '2018-04',
    'basis': 'Nutrients per 100 g edible portion',
    'foods': catalog
}
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(payload, separators=(',', ':'), ensure_ascii=False), encoding='utf-8')
print(f"wrote {len(catalog)} foods to {output} ({output.stat().st_size / 1024 / 1024:.2f} MiB)")
