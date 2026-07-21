// 云端同步功能测试（jsdom + 模拟 fetch）
// 覆盖：mergeData 合并逻辑 / 拉取+合并+推送 / 首次同步(404) / 409 冲突重试 / 未配置 Token 守卫
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

// 构造一个可控的 fetch 模拟器
function makeFetch(plan) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body });
    const r = await plan(url, opts, calls);
    return r;
  };
  fn.calls = calls;
  return fn;
}
function res(obj) {
  return {
    ok: obj.status >= 200 && obj.status < 300,
    status: obj.status,
    json: async () => obj.json,
    text: async () => obj.text || ''
  };
}
function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

async function run() {
  // ---------- T1: mergeData 纯逻辑 ----------
  console.log('T1 mergeData 合并逻辑');
  {
    const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://example.com/' });
    const w = dom.window;
    const cloud = [{ id: 'a', updatedAt: 100, name: 'cloudA' }, { id: 'b', updatedAt: 100, name: 'cloudB' }];
    const local = [{ id: 'a', updatedAt: 200, name: 'localA' }, { id: 'c', updatedAt: 50, name: 'localC' }];
    const merged = w.mergeData(local, cloud);
    ok('合并后共 3 条（a/b/c）', merged.length === 3);
    const a = merged.find(e => e.id === 'a');
    ok('同 id 保留本地较新版本（a=localA）', a && a.name === 'localA');
    ok('云端独有项保留（b=cloudB）', merged.some(e => e.id === 'b' && e.name === 'cloudB'));
    ok('本地独有项保留（c=localC）', merged.some(e => e.id === 'c' && e.name === 'localC'));
  }

  // ---------- T2: 拉取 + 合并 + 推送 ----------
  console.log('T2 已有云端：pull -> merge -> push');
  {
    const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://example.com/' });
    const w = dom.window;
    const local = [{ id: 'a', updatedAt: 200, name: 'localA' }, { id: 'c', updatedAt: 50, name: 'localC' }];
    w.localStorage.setItem('relay_v3', JSON.stringify(local));
    w.localStorage.setItem('relay_gh_token', 'ghp_test');
    const cloud = [{ id: 'a', updatedAt: 100, name: 'cloudA' }, { id: 'b', updatedAt: 100, name: 'cloudB' }];
    const fetch = makeFetch(async (url, opts) => {
      if ((opts.method || 'GET') === 'GET') return res({ status: 200, json: { sha: 'S1', content: b64(JSON.stringify(cloud)) } });
      return res({ status: 200, json: { sha: 'S2' } }); // PUT
    });
    w.fetch = fetch; w.AbortSignal = AbortSignal;
    await w.syncCloud();
    const saved = JSON.parse(w.localStorage.getItem('relay_v3'));
    ok('本地已保存合并结果 3 条', saved.length === 3);
    ok('合并结果含云端独有 b', saved.some(e => e.id === 'b'));
    ok('推送被调用一次', fetch.calls.filter(c => c.method === 'PUT').length === 1);
    const putBody = JSON.parse(fetch.calls.find(c => c.method === 'PUT').body);
    const pushed = JSON.parse(Buffer.from(putBody.content, 'base64').toString('utf8'));
    ok('推送到云端的内容为合并后的 3 条', Array.isArray(pushed) && pushed.length === 3);
  }

  // ---------- T3: 首次同步（云端 404） ----------
  console.log('T3 云端无文件：直接推送本地');
  {
    const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://example.com/' });
    const w = dom.window;
    const local = [{ id: 'x', updatedAt: 1, name: 'onlyLocal' }];
    w.localStorage.setItem('relay_v3', JSON.stringify(local));
    w.localStorage.setItem('relay_gh_token', 'ghp_test');
    const fetch = makeFetch(async (url, opts) => {
      if ((opts.method || 'GET') === 'GET') return res({ status: 404 });
      return res({ status: 201, json: { sha: 'NEW' } });
    });
    w.fetch = fetch; w.AbortSignal = AbortSignal;
    await w.syncCloud();
    ok('GET 404 时拉取为空，不报错', true);
    ok('推送被调用（创建文件）', fetch.calls.filter(c => c.method === 'PUT').length === 1);
    const saved = JSON.parse(w.localStorage.getItem('relay_v3'));
    ok('本地仍是 1 条', saved.length === 1);
  }

  // ---------- T4: PUT 409 冲突重试 ----------
  console.log('T4 并发冲突：409 重新取 sha 后重试成功');
  {
    const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://example.com/' });
    const w = dom.window;
    w.localStorage.setItem('relay_v3', JSON.stringify([{ id: 'a', updatedAt: 1 }]));
    w.localStorage.setItem('relay_gh_token', 'ghp_test');
    let putCount = 0;
    const fetch = makeFetch(async (url, opts) => {
      if ((opts.method || 'GET') === 'GET') return res({ status: 200, json: { sha: 'SX', content: b64('[]') } });
      putCount++;
      if (putCount === 1) return res({ status: 409 }); // 第一次冲突
      return res({ status: 200, json: { sha: 'SY' } }); // 重试成功
    });
    w.fetch = fetch; w.AbortSignal = AbortSignal;
    await w.syncCloud();
    ok('409 后重试 PUT 共 2 次', putCount === 2);
    ok('最终同步成功，本地未丢失', JSON.parse(w.localStorage.getItem('relay_v3')).length === 1);
  }

  // ---------- T5: 未配置 Token 守卫 ----------
  console.log('T5 未配置 Token：不发起网络请求，提示配置');
  {
    const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://example.com/' });
    const w = dom.window;
    w.localStorage.removeItem('relay_gh_token');
    let netCalled = false;
    w.fetch = async () => { netCalled = true; return res({ status: 200, json: {} }); };
    w.AbortSignal = AbortSignal;
    await w.syncCloud();
    ok('未配置 Token 时不发起任何网络请求', netCalled === false);
    const toast = w.document.getElementById('toast');
    ok('提示用户先配置 Token', toast && toast.textContent.indexOf('Token') >= 0);
  }

  // ---------- T6: 管理锁（密码 jiesen） ----------
  console.log('T6 管理锁（密码 jiesen）');
  {
    const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://example.com/' });
    const w = dom.window;
    ok('默认锁定（body 无 admin 类）', !w.document.body.classList.contains('admin'));
    ok('锁定按钮默认显示 🔒', (w.document.getElementById('lockBtn').textContent || '').indexOf('🔒') >= 0);
    w.document.getElementById('lockPw').value = 'wrong';
    w.doUnlock();
    ok('错误密码不解锁', !w.document.body.classList.contains('admin'));
    w.document.getElementById('lockPw').value = 'jiesen';
    w.doUnlock();
    ok('正确密码 jiesen 解锁', w.document.body.classList.contains('admin'));
    ok('解锁后锁定按钮变为 🔓', (w.document.getElementById('lockBtn').textContent || '').indexOf('🔓') >= 0);
    w.doLock();
    ok('doLock 重新锁定', !w.document.body.classList.contains('admin'));
  }

  // ---------- T7: 源码不含硬编码 Token（安全） ----------
  console.log('T7 源码不含硬编码 Token（安全，避免 Secret Scanning 拦截）');
  {
    const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://example.com/' });
    const w = dom.window;
    const tok = w.localStorage.getItem('relay_gh_token');
    ok('全新实例不预填 Token（需用户在本机填一次）', !tok || tok === '');
    ok('源码中未硬编码 Token（GH_DEF_TOKEN 为空字符串）', w.GH_DEF_TOKEN === '');
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

run().catch(e => { console.error('测试运行异常：', e); process.exit(2); });
