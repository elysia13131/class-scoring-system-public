import json

with open('data/members.json', 'r', encoding='utf-8') as f:
    members = json.load(f)

for member in members:
    if 'height' in member:
        del member['height']
    if 'weight' in member:
        del member['weight']

with open('data/members.json', 'w', encoding='utf-8') as f:
    json.dump(members, f, ensure_ascii=False, indent=2)

print('已删除members.json中的height和weight字段')
