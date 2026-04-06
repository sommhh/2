(() => {
  "use strict";

  const STORAGE_KEYS = {
    current: "denzai_current_v4",
    history: "denzai_history_v4",
    freq: "denzai_freq_v4"
  };

  const $ = id => document.getElementById(id);

  const els = {
    manual: $("manual"),
    video: $("video"),
    status: $("status"),
    ocrBox: $("ocrBox"),
    ocrCandidates: $("ocrCandidates"),
    matchBox: $("matchBox"),
    matchCandidates: $("matchCandidates"),
    linksBox: $("linksBox"),
    links: $("links"),
    suggestions: $("suggestions"),
    currentList: $("currentList"),
    currentCount: $("currentCount"),
    companyName: $("companyName"),
    personName: $("personName"),
    remarks: $("remarks"),
    orderPreview: $("orderPreview"),
    lineBtn: $("lineBtn"),
    historyList: $("historyList"),
    historyCount: $("historyCount")
  };

  let stream = null;
  let worker = null;
  let products = [];
  let currentScanCandidates = [];

  function load(key, fallback){
    try{
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    }catch(e){
      return fallback;
    }
  }

  function save(key, value){
    localStorage.setItem(key, JSON.stringify(value));
  }

  function nowIso(){
    return new Date().toISOString();
  }

  function formatDate(iso){
    const d = new Date(iso);
    if(isNaN(d)) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,"0");
    const day = String(d.getDate()).padStart(2,"0");
    const hh = String(d.getHours()).padStart(2,"0");
    const mm = String(d.getMinutes()).padStart(2,"0");
    return `${y}/${m}/${day} ${hh}:${mm}`;
  }

  function escapeHtml(str){
    return String(str || "")
      .replace(/&/g,"&amp;")
      .replace(/</g,"&lt;")
      .replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;")
      .replace(/'/g,"&#39;");
  }

  function normalizeCode(str){
    return String(str || "")
      .toUpperCase()
      .replace(/[　\s]+/g,"")
      .replace(/[^A-Z0-9\-_/.\u30FC]/g,"");
  }

  function normalizeLoose(str){
    return normalizeCode(str).replace(/[-_/.\u30FC]/g,"");
  }

  function setStatus(msg, type="info"){
    els.status.textContent = msg || "";
    els.status.style.color =
      type === "success" ? "#69f0ae" :
      type === "error" ? "#ff8a80" :
      "#90caf9";
  }

  function scoreCode(c){
    let s = 0;
    if(c.length >= 4) s += 2;
    if(c.length >= 6) s += 2;
    if(/[A-Z]/.test(c)) s += 3;
    if(/\d/.test(c)) s += 3;
    if(/[-/.]/.test(c)) s += 2;
    if(/^[A-Z0-9\-/.]+$/.test(c)) s += 2;
    if(/^[0-9]+$/.test(c)) s -= 3;
    if(c.length > 24) s -= 2;
    return s;
  }

  function extractCodes(text){
    const raw = (String(text || "").toUpperCase().match(/[A-Z0-9][A-Z0-9\-/.]{2,24}/g) || []);
    const cleaned = raw
      .map(v => v.replace(/^[\-/.]+|[\-/.]+$/g,""))
      .filter(v => v.length >= 3);
    return [...new Set(cleaned)].sort((a,b) => scoreCode(b) - scoreCode(a));
  }

  function fixCommonOcrErrors(code){
    const p = normalizeCode(code);
    return [
      p,
      p.replace(/I/g,"1"),
      p.replace(/O/g,"0"),
      p.replace(/S/g,"5"),
      p.replace(/B/g,"8"),
      p.replace(/Z/g,"2"),
      p.replace(/Q/g,"0")
    ].filter((v,i,a) => v && a.indexOf(v) === i);
  }

  function levenshtein(a,b){
    const m = a.length, n = b.length;
    const dp = Array.from({length:m+1},()=>Array(n+1).fill(0));
    for(let i=0;i<=m;i++) dp[i][0]=i;
    for(let j=0;j<=n;j++) dp[0][j]=j;
    for(let i=1;i<=m;i++){
      for(let j=1;j<=n;j++){
        const cost = a[i-1]===b[j-1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i-1][j]+1,
          dp[i][j-1]+1,
          dp[i-1][j-1]+cost
        );
      }
    }
    return dp[m][n];
  }

  function matchProducts(input){
    const variants = fixCommonOcrErrors(input);
    const results = [];

    for(const p of products){
      const code = normalizeCode(p.code);
      const looseCode = normalizeLoose(code);
      let bestScore = 0;

      for(const v of variants){
        const looseV = normalizeLoose(v);

        if(v === code) bestScore = Math.max(bestScore, 100);
        else if(looseV === looseCode) bestScore = Math.max(bestScore, 95);
        else if(code.startsWith(v) || v.startsWith(code)) bestScore = Math.max(bestScore, 88);
        else if(looseCode.includes(looseV) || looseV.includes(looseCode)) bestScore = Math.max(bestScore, 82);
        else{
          const dist = levenshtein(looseV, looseCode);
          const maxLen = Math.max(looseV.length, looseCode.length) || 1;
          const sim = Math.round((1 - dist / maxLen) * 100);
          if(sim >= 60) bestScore = Math.max(bestScore, sim);
        }

        if(Array.isArray(p.aliases)){
          for(const alias of p.aliases){
            const a = normalizeCode(alias);
            const la = normalizeLoose(a);
            if(v === a) bestScore = Math.max(bestScore, 93);
            else if(looseV === la) bestScore = Math.max(bestScore, 90);
          }
        }
      }

      if(bestScore >= 60){
        results.push({...p, score: bestScore});
      }
    }

    return results.sort((a,b) => b.score - a.score).slice(0,8);
  }

  async function loadProducts(){
    try{
      const res = await fetch("products.json");
      products = await res.json();
      setStatus(`辞書読込完了: ${products.length}件`);
    }catch(e){
      console.error(e);
      products = [];
      setStatus("辞書読込失敗", "error");
    }
  }

  async function getWorker(){
    if(worker) return worker;
    setStatus("OCR準備中...");
    worker = await Tesseract.createWorker("eng");
    await worker.setParameters({
      tessedit_char_whitelist:"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_/.",
      preserve_interword_spaces:"1"
    });
    return worker;
  }

  async function startCamera(){
    try{
      stopCamera();
      stream = await navigator.mediaDevices.getUserMedia({
        video:{
          facingMode:{ideal:"environment"},
          width:{ideal:1920},
          height:{ideal:1080}
        },
        audio:false
      });
      els.video.srcObject = stream;
      await els.video.play();
      setStatus("カメラ起動中");
    }catch(e){
      console.error(e);
      setStatus("カメラ起動失敗", "error");
      alert("カメラを起動できませんでした。ブラウザのカメラ許可を確認してください。");
    }
  }

  function stopCamera(){
    if(stream){
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    els.video.srcObject = null;
    setStatus("カメラ停止");
  }

  function captureFrame(){
    const canvas = document.createElement("canvas");
    canvas.width = els.video.videoWidth;
    canvas.height = els.video.videoHeight;
    const ctx = canvas.getContext("2d",{willReadFrequently:true});
    ctx.drawImage(els.video,0,0);
    return canvas;
  }

  function cropCenter(canvas){
    const w = canvas.width;
    const h = canvas.height;
    const cw = Math.floor(w * 0.78);
    const ch = Math.floor(h * 0.28);
    const x = Math.floor((w - cw) / 2);
    const y = Math.floor((h - ch) / 2);

    const out = document.createElement("canvas");
    out.width = cw;
    out.height = ch;
    const ctx = out.getContext("2d",{willReadFrequently:true});
    ctx.drawImage(canvas, x, y, cw, ch, 0, 0, cw, ch);
    return out;
  }

  function upscale(canvas, scale=2){
    const out = document.createElement("canvas");
    out.width = canvas.width * scale;
    out.height = canvas.height * scale;
    const ctx = out.getContext("2d",{willReadFrequently:true});
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas,0,0,out.width,out.height);
    return out;
  }

  function preprocess(canvas){
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext("2d",{willReadFrequently:true});
    ctx.drawImage(canvas,0,0);

    const img = ctx.getImageData(0,0,out.width,out.height);
    const d = img.data;

    for(let i=0;i<d.length;i+=4){
      let g = d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114;
      g = (g - 128) * 2.0 + 128;
      g = g > 150 ? 255 : g < 95 ? 0 : g;
      d[i] = d[i+1] = d[i+2] = Math.max(0, Math.min(255, g));
    }

    ctx.putImageData(img,0,0);
    return out;
  }

  async function scan(){
    if(!els.video.videoWidth){
      alert("先にカメラを起動してください");
      return;
    }

    setStatus("読取中...");
    els.ocrBox.style.display = "none";
    els.matchBox.style.display = "none";

    try{
      const full = captureFrame();
      const cropped = cropCenter(full);
      const enlarged = upscale(cropped, 2);
      const processed = preprocess(enlarged);

      const w = await getWorker();
      const ret = await w.recognize(processed);
      const text = ret?.data?.text || "";
      const codes = extractCodes(text);

      currentScanCandidates = codes.slice(0, 8);

      renderCandidates();
      setStatus(currentScanCandidates.length ? "候補を取得しました" : "候補なし");
    }catch(e){
      console.error(e);
      setStatus("読取失敗", "error");
      alert("読み取りに失敗しました。明るい場所で、品番を中央に大きく写して再度お試しください。");
    }
  }

  function renderCandidates(){
    els.ocrBox.style.display = "block";

    if(!currentScanCandidates.length){
      els.ocrCandidates.innerHTML = `
        <div class="item">
          <div class="item-meta">候補なし</div>
        </div>
      `;
      return;
    }

    els.ocrCandidates.innerHTML = currentScanCandidates.map((code, index) => `
      <div class="item">
        <div class="item-code">${escapeHtml(code)}</div>
        <div class="item-actions">
          <button class="btn-green" onclick="window.useScanCandidate(${index})">この候補を使う</button>
          <button class="btn-red" onclick="window.removeScanCandidate(${index})">消す</button>
        </div>
      </div>
    `).join("");
  }

  function removeScanCandidate(index){
    currentScanCandidates.splice(index, 1);
    renderCandidates();
    setStatus("候補を削除しました", "success");
  }

  function useScanCandidate(index){
    const code = currentScanCandidates[index];
    if(!code) return;

    const normalized = normalizeCode(code);
    els.manual.value = normalized;

    renderLinks(normalized);
    renderMatches(normalized);
    addCurrentItem(normalized);

    currentScanCandidates.splice(index, 1);
    renderCandidates();

    setStatus(`追加しました: ${normalized}`, "success");
  }

  function renderMatches(input){
    const p = normalizeCode(input);
    if(!p){
      els.matchBox.style.display = "none";
      els.matchCandidates.innerHTML = "";
      return;
    }

    const matches = matchProducts(p);
    if(!matches.length){
      els.matchBox.style.display = "none";
      els.matchCandidates.innerHTML = "";
      return;
    }

    els.matchBox.style.display = "block";
    els.matchCandidates.innerHTML = matches.map(item => `
      <div class="item">
        <div class="item-code">${escapeHtml(item.code)} / ${escapeHtml(item.name || "")}</div>
        <div class="item-meta">${escapeHtml(item.maker || "")} / ${escapeHtml(item.category || "")} / 一致度 ${item.score}</div>
        <div class="item-actions">
          <button class="btn-blue" onclick="window.useProductCode('${escapeHtml(item.code)}')">この品番を使う</button>
        </div>
      </div>
    `).join("");
  }

  function renderLinks(code){
    const p = normalizeCode(code);
    if(!p){
      els.linksBox.style.display = "none";
      els.links.innerHTML = "";
      return;
    }

    els.linksBox.style.display = "block";
    const q1 = encodeURIComponent(p);
    const q2 = encodeURIComponent(p + " 仕様書");
    const q3 = encodeURIComponent(p + " 図面");
    const q4 = encodeURIComponent(p + " Panasonic 未来工業");

    els.links.innerHTML = `
      <a href="https://www.google.com/search?q=${q1}" target="_blank" rel="noopener">検索</a>
      <a href="https://www.google.com/search?q=${q2}" target="_blank" rel="noopener">仕様書</a>
      <a href="https://www.google.com/search?q=${q3}" target="_blank" rel="noopener">図面</a>
      <a href="https://www.google.com/search?q=${q4}" target="_blank" rel="noopener">メーカー検索</a>
    `;
  }

  function getCurrent(){ return load(STORAGE_KEYS.current, []); }
  function saveCurrent(list){ save(STORAGE_KEYS.current, list); }
  function getHistory(){ cleanupHistory(); return load(STORAGE_KEYS.history, []); }
  function saveHistory(list){ save(STORAGE_KEYS.history, list); }
  function getFreq(){ return load(STORAGE_KEYS.freq, {}); }
  function saveFreq(obj){ save(STORAGE_KEYS.freq, obj); }

  function cleanupHistory(){
    const oneYear = 365 * 24 * 60 * 60 * 1000;
    const list = load(STORAGE_KEYS.history, []);
    const filtered = list.filter(v => {
      const t = new Date(v.createdAt).getTime();
      return Date.now() - t <= oneYear;
    });
    save(STORAGE_KEYS.history, filtered);
  }

  function addFreq(code){
    const p = normalizeCode(code);
    if(!p) return;
    const freq = getFreq();
    freq[p] = (freq[p] || 0) + 1;
    saveFreq(freq);
    renderSuggestions();
  }

  function renderSuggestions(){
    const freq = getFreq();
    const entries = Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,12);
    if(!entries.length){
      els.suggestions.innerHTML = `<span class="small">まだ候補はありません。</span>`;
      return;
    }
    els.suggestions.innerHTML = entries.map(([code,count]) =>
      `<span class="suggest-chip" onclick="window.pickCode('${escapeHtml(code)}')">${escapeHtml(code)} (${count})</span>`
    ).join("");
  }

  function addCurrentItem(code){
    const p = normalizeCode(code);
    if(!p){
      alert("品番を入力してください");
      return;
    }

    const matched = products.find(v => normalizeCode(v.code) === p);
    const list = getCurrent();
    const found = list.find(v => v.code === p);

    if(found){
      found.qty = (found.qty || 1) + 1;
      found.updatedAt = nowIso();
    }else{
      list.unshift({
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
        code: p,
        name: matched?.name || "",
        maker: matched?.maker || "",
        category: matched?.category || "",
        qty: 1,
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
    }

    saveCurrent(list);
    addFreq(p);
    renderCurrent();
    buildOrderText();
  }

  function updateQty(id, delta){
    const list = getCurrent();
    const item = list.find(v => v.id === id);
    if(!item) return;
    item.qty = Math.max(1, (item.qty || 1) + delta);
    item.updatedAt = nowIso();
    saveCurrent(list);
    renderCurrent();
    buildOrderText();
  }

  function removeCurrent(id){
    const list = getCurrent().filter(v => v.id !== id);
    saveCurrent(list);
    renderCurrent();
    buildOrderText();
  }

  function clearCurrent(){
    if(!confirm("現在リストを全削除しますか？")) return;
    saveCurrent([]);
    renderCurrent();
    buildOrderText();
  }

  function renderCurrent(){
    const list = getCurrent();
    els.currentCount.textContent = `${list.length}件`;

    if(!list.length){
      els.currentList.innerHTML = `<div class="small">まだ追加されていません。</div>`;
      return;
    }

    els.currentList.innerHTML = list.map(item => `
      <div class="item">
        <div class="item-code">${escapeHtml(item.code)}${item.name ? " / " + escapeHtml(item.name) : ""}</div>
        <div class="item-meta">${escapeHtml(item.maker || "")}${item.category ? " / " + escapeHtml(item.category) : ""}</div>
        <div class="item-meta">数量: ${item.qty || 1} / 追加: ${formatDate(item.createdAt)}</div>
        <div class="item-actions no-print">
          <button class="btn-gray" onclick="window.changeQty('${item.id}',-1)">-1</button>
          <button class="btn-green" onclick="window.changeQty('${item.id}',1)">+1</button>
          <button class="btn-red" onclick="window.removeCurrentItem('${item.id}')">削除</button>
          <a class="btn btn-blue" href="https://www.google.com/search?q=${encodeURIComponent(item.code)}" target="_blank" rel="noopener">検索</a>
        </div>
      </div>
    `).join("");
  }

  function buildOrderText(){
    const company = els.companyName.value.trim();
    const person = els.personName.value.trim();
    const remarks = els.remarks.value.trim();
    const list = getCurrent();

    if(!list.length){
      els.orderPreview.textContent = "ここに注文文が表示されます。";
      updateLineLink("");
      return "";
    }

    const lines = [];
    lines.push("【注文リスト】");
    if(company) lines.push(`会社名: ${company}`);
    if(person) lines.push(`担当者: ${person}`);
    lines.push("");
    lines.push("■品番一覧");
    list.forEach((item, i) => {
      const label = item.name ? `${item.code} (${item.name})` : item.code;
      lines.push(`${i+1}. ${label} × ${item.qty || 1}`);
    });
    if(remarks){
      lines.push("");
      lines.push("■備考");
      lines.push(remarks);
    }
    lines.push("");
    lines.push(`作成日時: ${formatDate(nowIso())}`);

    const text = lines.join("\n");
    els.orderPreview.textContent = text;
    updateLineLink(text);
    return text;
  }

  function updateLineLink(text){
    if(!text){
      els.lineBtn.href = "#";
      return;
    }
    els.lineBtn.href = "https://line.me/R/msg/text/?" + encodeURIComponent(text);
  }

  async function copyText(text){
    try{
      await navigator.clipboard.writeText(text);
      setStatus("コピーしました", "success");
    }catch(e){
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      setStatus("コピーしました", "success");
    }
  }

  function saveCurrentToHistory(){
    const current = getCurrent();
    if(!current.length){
      alert("保存するリストがありません");
      return;
    }

    const text = buildOrderText();
    const history = getHistory();
    history.unshift({
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
      createdAt: nowIso(),
      companyName: els.companyName.value.trim(),
      personName: els.personName.value.trim(),
      remarks: els.remarks.value.trim(),
      items: current,
      text
    });
    saveHistory(history);
    renderHistory();
    setStatus("履歴に保存しました", "success");
  }

  function removeHistory(id){
    const list = getHistory().filter(v => v.id !== id);
    saveHistory(list);
    renderHistory();
  }

  function clearHistory(){
    if(!confirm("履歴を全削除しますか？")) return;
    saveHistory([]);
    renderHistory();
  }

  function restoreHistory(id){
    const item = getHistory().find(v => v.id === id);
    if(!item) return;
    saveCurrent(item.items || []);
    els.companyName.value = item.companyName || "";
    els.personName.value = item.personName || "";
    els.remarks.value = item.remarks || "";
    renderCurrent();
    buildOrderText();
    setStatus("履歴を読み込みました", "success");
  }

  function renderHistory(){
    const list = getHistory();
    els.historyCount.textContent = `${list.length}件`;

    if(!list.length){
      els.historyList.innerHTML = `<div class="small">保存履歴はありません。</div>`;
      return;
    }

    els.historyList.innerHTML = list.map(item => {
      const summary = (item.items || []).map(v => `${v.code} × ${v.qty || 1}`).join(", ");
      return `
        <div class="item">
          <div class="item-code">${escapeHtml(item.companyName || "会社名未入力")} / ${escapeHtml(item.personName || "担当者未入力")}</div>
          <div class="item-meta">${formatDate(item.createdAt)}</div>
          <div class="item-meta">${escapeHtml(summary)}</div>
          <div class="item-actions no-print">
            <button class="btn-blue" onclick="window.restoreHistoryItem('${item.id}')">読み込む</button>
            <button class="btn-green" onclick="window.copyHistoryItem('${item.id}')">コピー</button>
            <button class="btn-red" onclick="window.removeHistoryItem('${item.id}')">削除</button>
          </div>
        </div>
      `;
    }).join("");
  }

  function bindEvents(){
    $("startBtn").addEventListener("click", startCamera);
    $("scanBtn").addEventListener("click", scan);
    $("stopBtn").addEventListener("click", stopCamera);

    $("searchBtn").addEventListener("click", () => {
      renderLinks(els.manual.value);
      renderMatches(els.manual.value);
    });

    $("addBtn").addEventListener("click", () => {
      addCurrentItem(els.manual.value);
      setStatus(`追加しました: ${normalizeCode(els.manual.value)}`, "success");
    });

    $("buildOrderBtn").addEventListener("click", buildOrderText);
    $("saveHistoryBtn").addEventListener("click", saveCurrentToHistory);

    $("copyBtn").addEventListener("click", () => {
      const text = buildOrderText();
      if(!text){
        alert("コピーする注文文がありません");
        return;
      }
      copyText(text);
    });

    $("printBtn").addEventListener("click", () => {
      buildOrderText();
      window.print();
    });

    $("clearCurrentBtn").addEventListener("click", clearCurrent);
    $("clearHistoryBtn").addEventListener("click", clearHistory);

    els.manual.addEventListener("input", () => {
      const v = normalizeCode(els.manual.value);
      if(els.manual.value !== v) els.manual.value = v;
      renderMatches(v);
    });

    els.companyName.addEventListener("input", buildOrderText);
    els.personName.addEventListener("input", buildOrderText);
    els.remarks.addEventListener("input", buildOrderText);
  }

  window.pickCode = function(code){
    els.manual.value = normalizeCode(code);
    renderLinks(els.manual.value);
    renderMatches(els.manual.value);
  };

  window.useProductCode = function(code){
    const normalized = normalizeCode(code);
    els.manual.value = normalized;
    addCurrentItem(normalized);
    renderLinks(normalized);
    renderMatches(normalized);
    setStatus(`追加しました: ${normalized}`, "success");
  };

  window.useScanCandidate = function(index){
    useScanCandidate(index);
  };

  window.removeScanCandidate = function(index){
    removeScanCandidate(index);
  };

  window.changeQty = function(id, delta){
    updateQty(id, delta);
  };

  window.removeCurrentItem = function(id){
    removeCurrent(id);
  };

  window.restoreHistoryItem = function(id){
    restoreHistory(id);
  };

  window.removeHistoryItem = function(id){
    removeHistory(id);
  };

  window.copyHistoryItem = function(id){
    const item = getHistory().find(v => v.id === id);
    if(item && item.text) copyText(item.text);
  };

  async function init(){
    await loadProducts();
    bindEvents();
    cleanupHistory();
    renderCurrent();
    renderHistory();
    renderSuggestions();
    buildOrderText();
    setStatus("準備完了");
  }

  init();
})();
