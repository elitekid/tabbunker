#!/bin/bash
# 이름 후보 충돌 검사: 크롬 스토어(검색 페이지), 파이어폭스(AMO API), npm, GitHub(in:name), DNS(.com/.app/.io)
# 사용: name-check.sh Name1 Name2 ...   → 마크다운 표 stdout
UA="Mozilla/5.0"
printf "| 후보 | 크롬 | 파이어폭스 | npm | GitHub | 도메인 | 판정 |\n|---|---|---|---|---|---|---|\n"
for name in "$@"; do
  lc=$(echo "$name" | tr 'A-Z' 'a-z' | tr -d ' -')
  spaced=$(echo "$name" | sed -E 's/([a-z])([A-Z])/\1 \2/g')
  html=$(curl -s -A "$UA" "https://chromewebstore.google.com/search/$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$name")")
  if echo "$html" | grep -q "aren't any search results"; then chrome="없음"; else
    titles=$(echo "$html" | grep -o -i "\"[^\"]\{0,40\}$lc[^\"]\{0,40\}\"" | grep -v -i "search/" | sort -u | head -4 | tr '\n' ' ')
    n=$(echo "$html" | grep -o -i "$lc" | wc -l | tr -d ' ')
    chrome="결과 있음(언급 $n) $titles"; fi
  amo=$(curl -s "https://addons.mozilla.org/api/v5/addons/search/?q=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$spaced")&type=extension&page_size=50" | python3 -c "
import sys,json,re
lc=sys.argv[1]; d=json.load(sys.stdin); hits=[]
for a in d.get('results',[]):
    n=a['name'].get('en-US') if isinstance(a['name'],dict) else a['name']
    if n and re.sub(r'[\s\-_]','',n).lower().find(lc)>=0: hits.append(n+'('+str(a.get('average_daily_users',0))+')')
print('없음' if not hits else ', '.join(hits[:4]))" "$lc")
  npm=$(curl -s -o /dev/null -w "%{http_code}" "https://registry.npmjs.org/$lc"); [ "$npm" = "404" ] && npm="없음" || npm="있음"
  gh=$(curl -s "https://api.github.com/search/repositories?q=$lc+in:name" | python3 -c "
import sys,json; d=json.load(sys.stdin); c=d.get('total_count'); items=[i['full_name'] for i in d.get('items',[])][:3]
print('없음' if c==0 else (str(c)+' '+', '.join(items) if c is not None else 'API제한'))")
  dom=""; for t in com app io; do r=$(dig +short "$lc.$t" NS 2>/dev/null | head -1); [ -n "$r" ] && dom="$dom .$t점유" || dom="$dom .$t빈"; done
  verdict="가능"; [ "$chrome" != "없음" ] && verdict="충돌?"; [ "$amo" != "없음" ] && verdict="충돌?"
  printf "| %s | %s | %s | %s | %s | %s | %s |\n" "$name" "$chrome" "$amo" "$npm" "$gh" "$dom" "$verdict"
  sleep 1
done
