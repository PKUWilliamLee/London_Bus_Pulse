#!/usr/bin/env python3
import json, urllib.parse, requests
from bs4 import BeautifulSoup

queries = [
    'site:hefei.gov.cn 合肥市 国民经济和社会发展 第十五个五年规划纲要 全文',
    'site:bozhou.gov.cn 亳州市 国民经济和社会发展 第十五个五年规划纲要 全文',
    'site:dingxi.gov.cn 定西市 国民经济和社会发展 第十五个五年规划纲要 全文',
    'site:zhuhai.gov.cn 珠海市 国民经济和社会发展 第十五个五年规划纲要 全文',
]
headers={'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36'}
out=[]
for q in queries:
    url='https://www.bing.com/search?q='+urllib.parse.quote(q)
    try:
        r=requests.get(url,headers=headers,timeout=30)
        soup=BeautifulSoup(r.text,'html.parser')
        items=[]
        for a in soup.select('li.b_algo h2 a')[:10]:
            items.append({'title':a.get_text(' ',strip=True),'url':a.get('href')})
        out.append({'query':q,'status':r.status_code,'length':len(r.text),'items':items})
    except Exception as e:
        out.append({'query':q,'error':repr(e)})
open('search_results.json','w',encoding='utf-8').write(json.dumps(out,ensure_ascii=False,indent=2))
print(json.dumps(out,ensure_ascii=False,indent=2))
