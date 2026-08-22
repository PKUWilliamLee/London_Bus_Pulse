#!/usr/bin/env python3
import json, urllib.parse, requests, re
from bs4 import BeautifulSoup

queries = [
    'site:hefei.gov.cn 合肥市 国民经济和社会发展 第十五个五年规划纲要 全文',
    'site:bozhou.gov.cn 亳州市 国民经济和社会发展 第十五个五年规划纲要 全文',
    'site:dingxi.gov.cn 定西市 国民经济和社会发展 第十五个五年规划纲要 全文',
    'site:zhuhai.gov.cn 珠海市 国民经济和社会发展 第十五个五年规划纲要 全文',
]
headers={'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36','Accept-Language':'zh-CN,zh;q=0.9,en;q=0.5'}

def anchors(soup, selectors):
    items=[]
    seen=set()
    for sel in selectors:
        for a in soup.select(sel):
            u=a.get('href') or ''
            t=a.get_text(' ',strip=True)
            if u and u not in seen:
                seen.add(u); items.append({'title':t,'url':u})
    return items[:15]

engines=[
 ('baidu',lambda q:'https://www.baidu.com/s?wd='+urllib.parse.quote(q),['h3 a','a.c-showurl']),
 ('so360',lambda q:'https://www.so.com/s?q='+urllib.parse.quote(q),['h3 a','h2 a']),
 ('sogou',lambda q:'https://www.sogou.com/web?query='+urllib.parse.quote(q),['h3 a','h4 a']),
 ('google',lambda q:'https://www.google.com/search?hl=zh-CN&q='+urllib.parse.quote(q),['a']),
 ('bing',lambda q:'https://www.bing.com/search?q='+urllib.parse.quote(q),['li.b_algo h2 a']),
]
out=[]
for q in queries:
  rec={'query':q,'engines':[]}
  for name,makeurl,selectors in engines:
    url=makeurl(q)
    try:
      r=requests.get(url,headers=headers,timeout=30,allow_redirects=True)
      soup=BeautifulSoup(r.text,'html.parser')
      items=anchors(soup,selectors)
      # keep useful-looking Google anchors only
      if name=='google':
        cleaned=[]
        for x in items:
          u=x['url']
          if u.startswith('/url?q='):
            u=urllib.parse.parse_qs(urllib.parse.urlparse(u).query).get('q',[''])[0]
          if u.startswith('http') and 'google.' not in urllib.parse.urlparse(u).netloc:
            cleaned.append({'title':x['title'],'url':u})
        items=cleaned[:15]
      rec['engines'].append({'name':name,'status':r.status_code,'final_url':r.url,'length':len(r.text),'title':soup.title.get_text(' ',strip=True) if soup.title else '', 'items':items})
    except Exception as e:
      rec['engines'].append({'name':name,'error':repr(e)})
  out.append(rec)
open('search_results.json','w',encoding='utf-8').write(json.dumps(out,ensure_ascii=False,indent=2))
print(json.dumps(out,ensure_ascii=False,indent=2))
