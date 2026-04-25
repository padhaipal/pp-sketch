export const QUIZ_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PadhaiPal Quiz — What if every Indian child could read?</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.6/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg: #fff8ef;
    --ink: #21243d;
    --muted: #6b7080;
    --accent: #f29e38;
    --accent-dark: #d97a0a;
    --correct: #2c8a4f;
    --you: #e44c5e;
    --card: #ffffff;
    --border: #ecdfc9;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 24px 18px 80px; }
  .brand { font-size: 14px; letter-spacing: .14em; text-transform: uppercase;
    color: var(--accent-dark); font-weight: 700; }
  h1 { font-size: 30px; line-height: 1.25; margin: 8px 0 4px; }
  h2 { font-size: 22px; line-height: 1.3; margin: 0 0 16px; font-weight: 600; }
  p  { line-height: 1.55; color: var(--ink); }
  .lede { color: var(--muted); margin: 0 0 24px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px;
    padding: 22px; box-shadow: 0 1px 0 rgba(0,0,0,0.02); margin-bottom: 18px; }
  .premise { font-size: 17px; }
  .premise strong { color: var(--accent-dark); }
  .qnum { font-size: 13px; color: var(--muted); letter-spacing: .08em;
    text-transform: uppercase; margin-bottom: 6px; }
  .input-row { display: flex; align-items: stretch; gap: 8px; margin: 16px 0 8px; }
  .input-row input { flex: 1; font-size: 18px; padding: 12px 14px;
    border: 1.5px solid var(--border); border-radius: 10px; background: #fff; color: var(--ink);
    -webkit-appearance: none; appearance: none; outline: none; }
  .input-row input:focus { border-color: var(--accent); }
  .unit { display: flex; align-items: center; padding: 0 14px; font-size: 16px;
    color: var(--muted); background: #fbf2e2; border: 1.5px solid var(--border); border-radius: 10px; }
  .btn { display: inline-block; background: var(--accent); color: #fff; border: 0;
    border-radius: 10px; padding: 12px 22px; font-size: 16px; font-weight: 600; cursor: pointer;
    transition: background .15s ease; }
  .btn:hover { background: var(--accent-dark); }
  .btn:disabled { opacity: .5; cursor: not-allowed; }
  .btn-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .legend { display: flex; gap: 18px; flex-wrap: wrap; font-size: 13px; color: var(--muted);
    margin: 4px 0 6px; }
  .legend-item { display: inline-flex; align-items: center; gap: 6px; }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .dot-correct { background: var(--correct); }
  .dot-you { background: var(--you); }
  .dot-others { background: #c8cbd6; }
  .reveal { font-size: 16px; }
  .reveal .answer { color: var(--correct); font-weight: 700; }
  .reveal .yours { color: var(--you); font-weight: 700; }
  .chart-box { position: relative; height: 140px; margin-top: 10px; }
  .summary-q { padding: 18px 0; border-top: 1px dashed var(--border); }
  .summary-q:first-of-type { border-top: 0; }
  .summary-q h3 { margin: 0 0 4px; font-size: 17px; }
  .summary-q .answer-line { color: var(--muted); font-size: 14px; margin: 0 0 8px; }
  .completed { font-size: 18px; margin: 12px 0; }
  .completed .num { color: var(--accent-dark); font-weight: 700; }
  a { color: var(--accent-dark); }
  .footer-link { font-size: 14px; color: var(--muted); margin-top: 18px; }
  .progress { display: flex; gap: 6px; margin: 6px 0 22px; }
  .progress span { flex: 1; height: 6px; background: #ecdfc9; border-radius: 3px; }
  .progress span.done { background: var(--accent); }
  .progress span.current { background: var(--accent-dark); }
</style>
</head>
<body>
<div class="wrap">

  <div class="brand">PadhaiPal · Supporter Update</div>
  <h1>What if every Indian child could read?</h1>
  <p class="lede">A 5-question quiz. Take a guess — then see what the research says.</p>

  <div id="app"></div>

</div>

<script>
(function () {
  var QUESTIONS = [
    {
      prompt: "How much richer would the country be?",
      unit: "$ trillion",
      placeholder: "e.g. 5",
      correct: 37,
      formatAnswer: function (n) { return "$" + fmtNum(n) + " trillion"; },
      correctText: "<span class=\\"answer\\">$37 trillion</span>",
      min: 0, max: 200, step: 0.1,
    },
    {
      prompt: "How much higher would India's per capita GDP be?",
      unit: "%",
      placeholder: "e.g. 20",
      correct: 47,
      formatAnswer: function (n) { return fmtNum(n) + "%"; },
      correctText: "<span class=\\"answer\\">47% higher</span>",
      min: 0, max: 300, step: 0.1,
    },
    {
      prompt: "How many more Indian children would have gone to secondary school?",
      unit: "million",
      placeholder: "e.g. 10",
      correct: 44,
      formatAnswer: function (n) { return fmtNum(n) + " million"; },
      correctText: "<span class=\\"answer\\">44 million</span> — that's roughly 1.6× Australia's population!",
      min: 0, max: 300, step: 0.1,
    },
    {
      prompt: "How many Indian child marriages would have been averted?",
      unit: "million",
      placeholder: "e.g. 0.5",
      correct: 1,
      formatAnswer: function (n) { return fmtNum(n) + " million"; },
      correctText: "<span class=\\"answer\\">1 million</span>",
      min: 0, max: 20, step: 0.05,
    },
    {
      prompt: "How many children's lives would be saved (because their mums can now read)?",
      unit: "thousand",
      placeholder: "e.g. 50",
      correct: 400,
      formatAnswer: function (n) { return fmtNum(n) + " thousand"; },
      correctText: "<span class=\\"answer\\">400,000</span>",
      min: 0, max: 5000, step: 10,
    },
  ];

  var PREMISE_HTML = "If <strong>90% of 10-year-olds</strong> in India became literate every year, then by <strong>2050</strong>…";

  var sessionId = (function () {
    var existing = null;
    try { existing = localStorage.getItem("padhaipal_quiz_session"); } catch (e) {}
    if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
    var sid = uuidv4();
    try { localStorage.setItem("padhaipal_quiz_session", sid); } catch (e) {}
    return sid;
  })();

  var state = {
    qIndex: 0,
    answers: new Array(QUESTIONS.length).fill(null),
    started: false,
  };

  function uuidv4() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function fmtNum(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (Math.abs(n) >= 100) return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  function progressBar(idx) {
    var parts = [];
    for (var i = 0; i < QUESTIONS.length; i++) {
      var cls = "";
      if (i < idx) cls = "done";
      else if (i === idx) cls = "current";
      parts.push("<span class=\\"" + cls + "\\"></span>");
    }
    return "<div class=\\"progress\\">" + parts.join("") + "</div>";
  }

  function api(path, opts) {
    return fetch(path, opts).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function submitAnswer(qIndex, answer) {
    return api("/quiz/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        question_index: qIndex,
        answer: answer,
      }),
    });
  }

  function fetchAnswers(qIndex) {
    return api("/quiz/answers?question=" + qIndex).then(function (r) {
      return r.answers || [];
    });
  }

  function fetchStats() {
    return api("/quiz/stats");
  }

  function renderIntro() {
    var root = document.getElementById("app");
    root.innerHTML = "";
    var card = el(
      "<div class=\\"card\\">" +
        "<p class=\\"premise\\">" + PREMISE_HTML + "</p>" +
        "<p>Five quick questions. Make a guess for each — then see what the research found and where your guess sits.</p>" +
        "<div class=\\"btn-row\\"><button class=\\"btn\\" id=\\"start-btn\\">Start the quiz</button></div>" +
      "</div>"
    );
    root.appendChild(card);
    document.getElementById("start-btn").addEventListener("click", function () {
      state.started = true;
      state.qIndex = 0;
      renderQuestion();
    });
  }

  function renderQuestion() {
    var idx = state.qIndex;
    var q = QUESTIONS[idx];
    var root = document.getElementById("app");
    root.innerHTML = "";

    var card = el(
      "<div class=\\"card\\">" +
        progressBar(idx) +
        "<div class=\\"qnum\\">Question " + (idx + 1) + " of " + QUESTIONS.length + "</div>" +
        "<p class=\\"premise\\">" + PREMISE_HTML + "</p>" +
        "<h2>" + q.prompt + "</h2>" +
        "<div class=\\"input-row\\">" +
          "<input id=\\"answer-input\\" type=\\"number\\" inputmode=\\"decimal\\" " +
            "min=\\"" + q.min + "\\" max=\\"" + q.max + "\\" step=\\"" + q.step + "\\" " +
            "placeholder=\\"" + q.placeholder + "\\" />" +
          "<div class=\\"unit\\">" + q.unit + "</div>" +
        "</div>" +
        "<div class=\\"btn-row\\"><button class=\\"btn\\" id=\\"submit-btn\\">Submit guess</button></div>" +
      "</div>"
    );
    root.appendChild(card);

    var input = document.getElementById("answer-input");
    var btn = document.getElementById("submit-btn");
    input.focus();
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") btn.click();
    });
    btn.addEventListener("click", function () {
      var raw = input.value;
      var val = parseFloat(raw);
      if (raw === "" || isNaN(val)) {
        input.focus();
        input.style.borderColor = "var(--you)";
        return;
      }
      btn.disabled = true;
      btn.textContent = "Saving…";
      state.answers[idx] = val;
      submitAnswer(idx, val).then(function () {
        return fetchAnswers(idx);
      }).then(function (allAnswers) {
        renderReveal(idx, val, allAnswers);
      }).catch(function () {
        btn.disabled = false;
        btn.textContent = "Submit guess";
        alert("Something went wrong saving your answer. Please try again.");
      });
    });
  }

  function renderReveal(idx, userAnswer, allAnswers) {
    var q = QUESTIONS[idx];
    var root = document.getElementById("app");
    root.innerHTML = "";

    var isLast = idx === QUESTIONS.length - 1;
    var nextLabel = isLast ? "See the summary" : "Next question";

    var card = el(
      "<div class=\\"card\\">" +
        progressBar(idx) +
        "<div class=\\"qnum\\">Question " + (idx + 1) + " of " + QUESTIONS.length + "</div>" +
        "<h2>" + q.prompt + "</h2>" +
        "<p class=\\"reveal\\">You guessed <span class=\\"yours\\">" + q.formatAnswer(userAnswer) + "</span>. " +
          "The research says " + q.correctText + ".</p>" +
        "<div class=\\"legend\\">" +
          "<span class=\\"legend-item\\"><span class=\\"legend-dot dot-others\\"></span>Other guesses</span>" +
          "<span class=\\"legend-item\\"><span class=\\"legend-dot dot-you\\"></span>You</span>" +
          "<span class=\\"legend-item\\"><span class=\\"legend-dot dot-correct\\"></span>Research answer</span>" +
        "</div>" +
        "<div class=\\"chart-box\\"><canvas id=\\"chart-" + idx + "\\"></canvas></div>" +
        "<div class=\\"btn-row\\" style=\\"margin-top:14px\\">" +
          "<button class=\\"btn\\" id=\\"next-btn\\">" + nextLabel + "</button>" +
        "</div>" +
      "</div>"
    );
    root.appendChild(card);

    drawScatter("chart-" + idx, q, allAnswers, userAnswer);

    document.getElementById("next-btn").addEventListener("click", function () {
      if (isLast) {
        renderSummary();
      } else {
        state.qIndex++;
        renderQuestion();
      }
    });
  }

  function drawScatter(canvasId, q, allAnswers, userAnswer) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return;

    var values = allAnswers.slice();
    var maxVal = Math.max.apply(null, values.concat([q.correct, userAnswer]));
    var minVal = Math.min.apply(null, values.concat([q.correct, userAnswer, 0]));
    var span = Math.max(1, maxVal - minVal);
    var pad = span * 0.08;
    var xMin = Math.max(0, minVal - pad);
    var xMax = maxVal + pad;

    function jitterPoints(arr, excludeUser) {
      return arr.map(function (v) { return { x: v, y: jitter() }; });
    }
    function jitter() { return (Math.random() - 0.5) * 0.6; }

    var others = values.map(function (v) { return { x: v, y: jitter() }; });

    var youDataset = {
      label: "Your guess",
      data: [{ x: userAnswer, y: 0 }],
      backgroundColor: "#e44c5e",
      borderColor: "#e44c5e",
      pointRadius: 9,
      pointHoverRadius: 9,
      pointStyle: "circle",
      order: 1,
    };
    var correctDataset = {
      label: "Research answer",
      data: [{ x: q.correct, y: 0 }],
      backgroundColor: "#2c8a4f",
      borderColor: "#2c8a4f",
      pointRadius: 11,
      pointHoverRadius: 11,
      pointStyle: "rectRot",
      order: 0,
    };
    var othersDataset = {
      label: "Other guesses",
      data: others,
      backgroundColor: "rgba(120, 130, 150, 0.55)",
      borderColor: "rgba(120, 130, 150, 0.7)",
      pointRadius: 4,
      pointHoverRadius: 5,
      order: 2,
    };

    new Chart(canvas, {
      type: "scatter",
      data: { datasets: [othersDataset, youDataset, correctDataset] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                return ctx.dataset.label + ": " + q.formatAnswer(ctx.parsed.x);
              },
              title: function () { return ""; },
            },
          },
        },
        scales: {
          x: {
            type: "linear",
            min: xMin,
            max: xMax,
            title: { display: true, text: q.unit },
            ticks: {
              callback: function (v) { return fmtNum(v); },
            },
            grid: { color: "rgba(0,0,0,0.05)" },
          },
          y: {
            min: -1, max: 1,
            display: false,
            grid: { display: false },
          },
        },
      },
    });
  }

  function renderSummary() {
    var root = document.getElementById("app");
    root.innerHTML = "";

    var intro = el(
      "<div class=\\"card\\">" +
        "<h2 style=\\"margin-bottom:6px\\">Quiz complete</h2>" +
        "<p class=\\"premise\\">" + PREMISE_HTML + "</p>" +
        "<div class=\\"completed\\" id=\\"completed-line\\">Loading…</div>" +
        "<p>Here's how everyone has answered so far. Your guesses are highlighted.</p>" +
      "</div>"
    );
    root.appendChild(intro);

    var summaryCard = el("<div class=\\"card\\" id=\\"summary-card\\"></div>");
    root.appendChild(summaryCard);

    for (var i = 0; i < QUESTIONS.length; i++) {
      (function (idx) {
        var q = QUESTIONS[idx];
        var userAnswer = state.answers[idx];
        var section = el(
          "<div class=\\"summary-q\\">" +
            "<div class=\\"qnum\\">Question " + (idx + 1) + "</div>" +
            "<h3>" + q.prompt + "</h3>" +
            "<p class=\\"answer-line\\">You: <span class=\\"yours\\" style=\\"color:#e44c5e;font-weight:700\\">" +
              (userAnswer === null ? "—" : q.formatAnswer(userAnswer)) +
              "</span> · Research: " + q.correctText + "</p>" +
            "<div class=\\"chart-box\\"><canvas id=\\"summary-chart-" + idx + "\\"></canvas></div>" +
          "</div>"
        );
        summaryCard.appendChild(section);
        fetchAnswers(idx).then(function (answers) {
          drawScatter("summary-chart-" + idx, q, answers, userAnswer);
        });
      })(i);
    }

    var footer = el(
      "<div class=\\"card\\">" +
        "<p>Want the full picture? Read the original insight note from " +
        "Wesleyan College's What Works Hub for Global Education:</p>" +
        "<p><a href=\\"https://www.wwhge.org/wp-content/uploads/2026/02/WWHGE_Universal-Foundational-Learning-Insight-Note.pdf\\" target=\\"_blank\\" rel=\\"noopener\\">" +
          "WWHGE — Universal Foundational Learning Insight Note (PDF)" +
        "</a></p>" +
        "<p class=\\"footer-link\\">Thank you for supporting PadhaiPal — we're building WhatsApp-based literacy tools so every child gets a real shot at reading.</p>" +
      "</div>"
    );
    root.appendChild(footer);

    fetchStats().then(function (s) {
      var n = s.completed || 0;
      var line = document.getElementById("completed-line");
      if (n <= 1) {
        line.innerHTML = "<span class=\\"num\\">" + n + "</span> " +
          (n === 1 ? "person has" : "people have") + " completed this quiz so far.";
      } else {
        line.innerHTML = "<span class=\\"num\\">" + n.toLocaleString() + "</span> people have completed this quiz so far.";
      }
    }).catch(function () {
      var line = document.getElementById("completed-line");
      if (line) line.textContent = "";
    });
  }

  renderIntro();
})();
</script>
</body>
</html>`;