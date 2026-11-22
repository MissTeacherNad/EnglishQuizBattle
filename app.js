/* English Quiz Battle — une seule salle, un professeur arbitre, Firebase RTDB.
   Le corrigé des questionnaires PERSONNALISÉS reste dans le navigateur du professeur.
   Aucun corrigé n'est diffusé à Firebase avant la révélation de la question.
   Les questions D'EXEMPLE incluses ici sont publiques : n'en faire aucun examen noté.
*/
'use strict';

const DEFAULT_QUIZ = {
  title: 'Family Vocabulary · 6e',
  duration: 20,
  questions: [
    { text: 'Comment dit-on « une tante » en anglais ?', options: ['An aunt', 'An uncle', 'A niece', 'A cousin'], correct: 0 },
    { text: 'Comment dit-on « un neveu » en anglais ?', options: ['A son', 'A grandson', 'A nephew', 'A brother'], correct: 2 },
    { text: 'Comment dit-on « une fille » (de ses parents) en anglais ?', options: ['A sister', 'A daughter', 'A mother', 'A niece'], correct: 1 },
    { text: 'Comment dit-on « un oncle » en anglais ?', options: ['A grandfather', 'A father', 'A cousin', 'An uncle'], correct: 3 },
    { text: 'Comment dit-on « les grands-parents » en anglais ?', options: ['Parents', 'Grandparents', 'Grandchildren', 'Relatives'], correct: 1 },
    { text: 'Comment dit-on « une nièce » en anglais ?', options: ['A niece', 'A granddaughter', 'An aunt', 'A daughter'], correct: 0 },
    { text: 'Comment dit-on « un fils » en anglais ?', options: ['A husband', 'A brother', 'A son', 'A father'], correct: 2 },
    { text: 'Comment dit-on « une épouse » en anglais ?', options: ['A mother', 'An aunt', 'A sister', 'A wife'], correct: 3 },
    { text: 'Comment dit-on « un frère » en anglais ?', options: ['A nephew', 'A brother', 'An uncle', 'A cousin'], correct: 1 },
    { text: 'Comment dit-on « un mari » en anglais ?', options: ['A father', 'A grandfather', 'A husband', 'A son'], correct: 2 }
  ]
};

const STORAGE_QUIZ = 'englishQuizBattleQuizV1';
const STORAGE_ROOM = 'englishQuizBattleRoomV1';
const letters = ['A', 'B', 'C', 'D'];
const icons = ['▲', '◆', '●', '■'];
const $app = document.getElementById('app');
const $status = document.getElementById('netStatus');
let db = null, auth = null, user = null, authPromise = null;
let online = false, offsetMs = 0;
let role = 'home', roomCode = '', meta = null;
let people = {}, rounds = {}, scores = {}, submissionsCount = 0;
let ownAnswer = null, joining = false, submitting = false, busy = false;
let quiz = loadQuiz(), sessionQuiz = null, myName = '';
let subscriptions = [], unsubscribeRound = null, answerSubscribedKey = null;
let toastTimeout = null;

function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
function safeJson(value) { try { return JSON.parse(value); } catch (_) { return null; } }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
function setStatus(text, kind = '') { $status.textContent = text; $status.className = 'status ' + kind; }
function toast(message) { const target = document.getElementById('toast'); target.textContent = message; target.classList.add('show'); clearTimeout(toastTimeout); toastTimeout = setTimeout(() => target.classList.remove('show'), 5500); }
function friendlyError(err) {
  console.error(err);
  if (!err) return 'Une erreur inconnue est survenue.';
  const c = err.code || '';
  if (c.includes('permission-denied') || c.includes('PERMISSION_DENIED')) return 'Accès refusé par Firebase. Vérifie les règles de sécurité ou l’état de la partie.';
  if (c.includes('auth/operation-not-allowed')) return 'Active la connexion anonyme dans Firebase Authentication.';
  if (c.includes('auth/unauthorized-domain')) return 'Ajoute le domaine de ce site dans les domaines autorisés Firebase Authentication.';
  if (c.includes('auth/network-request-failed')) return 'Connexion indisponible. Vérifie Internet et recommence.';
  return err.message || String(err);
}
function loadQuiz() { const stored = safeJson(localStorage.getItem(STORAGE_QUIZ)); return stored && validateQuiz(stored).length === 0 ? stored : clone(DEFAULT_QUIZ); }
function saveQuiz() { try { localStorage.setItem(STORAGE_QUIZ, JSON.stringify(quiz)); } catch (err) { console.warn('Local storage unavailable', err); } }
function validateQuiz(q) {
  const errors = [];
  if (!q || typeof q.title !== 'string' || !q.title.trim() || q.title.length > 80) errors.push('Donne un titre de 1 à 80 caractères.');
  if (!q || !Number.isInteger(Number(q.duration)) || Number(q.duration) < 5 || Number(q.duration) > 120) errors.push('Choisis une durée entre 5 et 120 secondes.');
  if (!q || !Array.isArray(q.questions) || q.questions.length < 1 || q.questions.length > 40) errors.push('Le quiz doit contenir de 1 à 40 questions.');
  if (Array.isArray(q?.questions)) q.questions.forEach((item, i) => {
    if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 260) errors.push(`Question ${i + 1} : intitulé manquant ou trop long.`);
    if (!Array.isArray(item.options) || item.options.length !== 4 || item.options.some(o => typeof o !== 'string' || !o.trim() || o.length > 130)) errors.push(`Question ${i + 1} : quatre réponses de 1 à 130 caractères sont nécessaires.`);
    if (Array.isArray(item.options) && new Set(item.options.map(o => String(o).trim().toLowerCase())).size !== 4) errors.push(`Question ${i + 1} : les quatre réponses doivent être différentes.`);
    if (!Number.isInteger(item.correct) || item.correct < 0 || item.correct > 3) errors.push(`Question ${i + 1} : précise la bonne réponse.`);
  });
  return errors;
}
function initFirebase() {
  const config = window.QB_FIREBASE_CONFIG;
  if (!config || !config.apiKey || config.apiKey.startsWith('REMPLACER') || !config.databaseURL || config.databaseURL.includes('REMPLACER')) {
    setStatus('Firebase à configurer', 'warn'); return;
  }
  if (typeof firebase === 'undefined') { setStatus('Chargement Firebase impossible', 'warn'); return; }
  try {
    firebase.initializeApp(config);
    auth = firebase.auth(); db = firebase.database();
    authPromise = auth.signInAnonymously().then(result => { user = result.user; setStatus('Connecté', 'ok'); online = true; return user; }).catch(err => { setStatus('Connexion refusée', 'warn'); console.error(err); return null; });
    db.ref('.info/connected').on('value', snap => { online = !!snap.val(); if (user) setStatus(online ? 'Connecté' : 'Hors ligne', online ? 'ok' : 'warn'); });
    db.ref('.info/serverTimeOffset').on('value', snap => { offsetMs = Number(snap.val()) || 0; });
    authPromise.then(() => restoreTeacherSession());
  } catch (err) { console.error(err); setStatus('Erreur de configuration', 'warn'); }
}
async function ensureReady() {
  if (!authPromise || !db) throw new Error('Configure Firebase avant de lancer une partie. Le fichier firebase-config.js n’est pas encore renseigné.');
  const person = await authPromise;
  if (!person) throw new Error('Authentification Firebase indisponible. Vérifie la connexion anonyme et les domaines autorisés.');
  if (!online) throw new Error('La connexion à Firebase n’est pas active.');
}
async function restoreTeacherSession() {
  const last = safeJson(localStorage.getItem(STORAGE_ROOM));
  if (!user || !last || !last.code || !last.quiz || validateQuiz(last.quiz).length) return;
  try {
    const snap = await db.ref(`rooms/${last.code}/meta`).get();
    if (snap.exists() && snap.val().ownerUid === user.uid) {
      role = 'host'; roomCode = last.code; sessionQuiz = last.quiz; connectRoom();
    } else localStorage.removeItem(STORAGE_ROOM);
  } catch (err) { console.warn('Resume failed', err); }
}
function clearListeners() { subscriptions.forEach(fn => fn()); subscriptions = []; if (unsubscribeRound) unsubscribeRound(); unsubscribeRound = null; answerSubscribedKey = null; }
function watch(path, handler) {
  const reference = db.ref(path);
  const callback = snap => handler(snap.val());
  reference.on('value', callback, err => toast(friendlyError(err)));
  const unsub = () => reference.off('value', callback);
  subscriptions.push(unsub); return unsub;
}
function connectRoom() {
  clearListeners();
  meta = null; people = {}; rounds = {}; scores = {}; ownAnswer = null; submissionsCount = 0;
  const base = `rooms/${roomCode}`;
  watch(`${base}/meta`, value => {
    meta = value;
    if (!meta) { toast('Cette partie n’existe plus.'); exitRoom(); return; }
    subscribeCurrentAnswer(); render();
  });
  watch(`${base}/participants`, value => { people = value || {}; render(); });
  watch(`${base}/rounds`, value => { rounds = value || {}; render(); });
  watch(`${base}/scores`, value => { scores = value || {}; render(); });
  render();
}
function subscribeCurrentAnswer() {
  const key = meta?.phase === 'question' || meta?.phase === 'reveal' ? String(meta.currentKey) : 'none';
  if (answerSubscribedKey === key) return;
  if (unsubscribeRound) { unsubscribeRound(); unsubscribeRound = null; }
  answerSubscribedKey = key; ownAnswer = null; submissionsCount = 0; submitting = false;
  if (key === 'none') return;
  const path = role === 'host' ? `rooms/${roomCode}/submissions/${key}` : `rooms/${roomCode}/submissions/${key}/${user.uid}`;
  const reference = db.ref(path);
  const listener = snap => {
    if (role === 'host') submissionsCount = Object.keys(snap.val() || {}).length;
    else ownAnswer = snap.val();
    render();
  };
  reference.on('value', listener, err => toast(friendlyError(err)));
  unsubscribeRound = () => reference.off('value', listener);
}
function exitRoom() {
  clearListeners(); role = 'home'; roomCode = ''; meta = null; people = {}; rounds = {}; scores = {}; sessionQuiz = null; ownAnswer = null; render();
}
function queryJoinCode() { return new URLSearchParams(location.search).get('join')?.replace(/\D/g, '').slice(0, 6) || ''; }
function baseLink() { return location.origin + location.pathname; }
function joinLink() { return baseLink() + '?join=' + encodeURIComponent(roomCode); }
function numberCode() { const value = new Uint32Array(1); crypto.getRandomValues(value); return String(100000 + (value[0] % 900000)); }
function nowServer() { return Date.now() + offsetMs; }
function currentRound() { return rounds[String(meta?.currentKey)] || null; }
function secondsLeft() { const q = currentRound(); return !q || typeof q.startedAt !== 'number' ? null : Math.max(0, Math.ceil((q.startedAt + q.duration * 1000 - nowServer()) / 1000)); }
function playersSorted() { return Object.entries(people).map(([uid, p]) => ({ uid, name: p.name || 'Élève', points: scores[uid]?.points || 0, correct: scores[uid]?.correct || 0 })).sort((a,b) => b.points-a.points || a.name.localeCompare(b.name, 'fr')); }
function leaderBoard(limit = 30, highlightUid = null) {
  const players = playersSorted();
  if (!players.length) return '<div class="empty">Aucun joueur pour le moment.</div>';
  return `<div class="rank-list">${players.slice(0,limit).map((p,i) => `<div class="rank ${p.uid===highlightUid ? 'me' : ''}"><span class="position">${i < 3 ? ['🥇','🥈','🥉'][i] : i + 1}</span><span class="nickname">${esc(p.name)}</span><span class="score">${p.points.toLocaleString('fr-FR')} pts</span></div>`).join('')}</div>`;
}
function render() {
  if (role === 'home') return renderHome();
  if (role === 'editor') return renderEditor();
  if (role === 'joining') return renderJoin();
  if (role === 'host') return renderHost();
  if (role === 'player') return renderPlayer();
}
function renderHome() {
  const incoming = queryJoinCode();
  $app.innerHTML = `<section class="hero"><span class="eyebrow">Interactive classroom</span><h1>Make learning<br>feel like a game.</h1><p>Des questions, un chronomètre et un classement en direct. Les élèves jouent sur leur propre appareil.</p></section>
  <div class="grid2"><section class="card"><div class="feature-icon">🎓</div><span class="kicker">Espace professeur</span><h2>Créer une partie</h2><p>Prépare ton quiz, affiche le code de connexion et pilote les questions au tableau.</p><button class="btn primary wide" data-action="editor">Préparer un quiz <span aria-hidden="true">→</span></button></section>
  <section class="card"><div class="feature-icon">⚡</div><span class="kicker">Espace élève</span><h2>Rejoindre la classe</h2><p>Entre le code affiché par le professeur et choisis un pseudonyme.</p><div class="field"><label for="homeCode">Code de la partie</label><input id="homeCode" inputmode="numeric" maxlength="6" placeholder="Ex. 123456" value="${esc(incoming)}"></div><button class="btn blue wide" data-action="go-join">Rejoindre <span aria-hidden="true">→</span></button></section></div>
  <p class="last-note">Aucune application à installer. Internet et la configuration Firebase sont nécessaires pour jouer sur plusieurs appareils.</p>`;
}
function renderEditor() {
  $app.innerHTML = `<div class="narrow"><div class="editor-head"><div><span class="kicker">Espace professeur</span><h1 class="big-title">Préparer ton quiz</h1><p class="muted">Modifie les questions, puis ouvre une salle pour tes élèves.</p></div><div class="top-actions"><button class="btn soft small" data-action="home">← Accueil</button><button class="btn outline small" data-action="export">Exporter JSON</button><label for="importFile" class="btn light small" style="cursor:pointer">Importer JSON</label><input id="importFile" type="file" accept="application/json,.json" class="file-input"></div></div>
  <section class="panel"><div class="settings-grid"><div class="field"><label for="quizTitle">Titre du quiz</label><input id="quizTitle" data-quiz-field="title" value="${esc(quiz.title)}" maxlength="80"></div><div class="field"><label for="quizDuration">Temps par question</label><select id="quizDuration" data-quiz-field="duration">${[10,15,20,30,45,60].map(v => `<option value="${v}" ${Number(quiz.duration)===v?'selected':''}>${v} s</option>`).join('')}</select></div></div><div class="info-line spaced">Une bonne réponse rapporte 500 à 1 000 points selon la rapidité. La bonne réponse n'est révélée qu'à la fin du temps.</div></section>
  <div class="section-title"><strong>Questions (${quiz.questions.length})</strong><button class="btn light small" data-action="add-question">＋ Ajouter</button></div>
  ${quiz.questions.map((q,i) => `<section class="question-edit"><div class="row between"><h3>Question ${i+1}</h3><button class="btn danger small" data-action="delete-question" data-index="${i}" ${quiz.questions.length<=1?'disabled':''}>Supprimer</button></div><div class="field"><label for="question${i}">Intitulé</label><input id="question${i}" data-index="${i}" data-question-field="text" maxlength="260" value="${esc(q.text)}"></div><div class="answer-edit">${q.options.map((opt,j)=> `<div class="field"><label for="option${i}-${j}">Réponse ${letters[j]}</label><input id="option${i}-${j}" data-index="${i}" data-option="${j}" maxlength="130" value="${esc(opt)}"></div>`).join('')}</div><div class="field spaced"><label for="correct${i}">Bonne réponse</label><select id="correct${i}" data-index="${i}" data-question-field="correct">${letters.map((letter,j)=> `<option value="${j}" ${j===q.correct?'selected':''}>Réponse ${letter}</option>`).join('')}</select></div></section>`).join('')}
  <div class="row wrap between spaced"><div class="muted tiny">Les modifications sont enregistrées sur cet appareil.</div><button class="btn primary" data-action="create">Créer la partie en direct →</button></div></div>`;
}
function renderJoin() {
  $app.innerHTML = `<div class="join-box"><section class="card center"><span class="kicker">Rejoins la partie</span><div class="display-icon">🎯</div><h1 class="big-title">Ready to play?</h1><p>Un code, un pseudonyme, et c'est parti.</p><div class="field" style="text-align:left"><label for="joinCode">Code à 6 chiffres</label><input id="joinCode" inputmode="numeric" maxlength="6" value="${esc(queryJoinCode())}" placeholder="123456" autocomplete="off"></div><div class="field" style="text-align:left"><label for="joinName">Ton pseudonyme</label><input id="joinName" maxlength="20" placeholder="Ex. BlueFox" autocomplete="nickname" value="${esc(myName)}"></div><button class="btn blue wide" data-action="join" ${joining?'disabled':''}>${joining ? 'Connexion…' : 'Entrer dans le jeu →'}</button><button class="btn soft wide" data-action="home">← Retour</button></section></div>`;
}
function renderHost() {
  if (!meta) { $app.innerHTML = '<div class="loading"><div class="spinner"></div><p>Ouverture de la salle…</p></div>'; return; }
  const phase = meta.phase, current = currentRound(), index = Number(meta.questionIndex) || 0;
  const top = `<div class="row between wrap" style="margin-bottom:17px"><div><span class="kicker">Écran professeur · ${esc(sessionQuiz?.title || meta.title)}</span><h1 class="big-title" style="margin:4px 0">${phase==='lobby'?'Salle d’attente':phase==='question'?'Question en cours':phase==='reveal'?'Résultats de la manche':'Classement final'}</h1></div><div class="top-actions"><span class="pill">Code ${esc(roomCode)}</span><button class="btn outline small" data-action="copy-link">Copier le lien</button></div></div>`;
  const lobby = `<section class="panel center"><span class="kicker">Rejoindre la partie</span><div class="game-code">${esc(roomCode)}</div><p>Sur leur appareil, les élèves ouvrent <strong>${esc(baseLink())}</strong> puis saisissent ce code.</p><div class="code-link">${esc(joinLink())}</div><div class="hr"></div><div class="count">${Object.keys(people).length}</div><div class="muted">joueur${Object.keys(people).length>1?'s':''} inscrit${Object.keys(people).length>1?'s':''}</div><div class="names" style="justify-content:center">${Object.values(people).map(p=>`<span class="name-chip">${esc(p.name)}</span>`).join('')}</div><button class="btn primary spaced" data-action="start" ${Object.keys(people).length===0?'disabled':''}>Démarrer le quiz →</button><p class="last-note">${esc(sessionQuiz?.questions.length || 0)} questions · ${esc(meta.duration)} secondes par question</p></section>`;
  let content = '';
  if (phase === 'lobby') content = lobby;
  if (phase === 'question' || phase === 'reveal') {
    content = current ? `<section class="panel"><div class="question-header"><span class="pill">Question ${index+1} / ${sessionQuiz?.questions.length || '?'}</span><span id="timer" class="timer">${phase==='question'?secondsLeft()??'–':'Terminé'}${phase==='question'?' s':''}</span></div><div class="bar"><span id="timerBar"></span></div><h2 class="question-title">${esc(current.question)}</h2><div class="answers">${current.options.map((opt,i) => answerHtml(opt,i,phase==='reveal'?current.correctIndex:null,null,false)).join('')}</div>${phase==='reveal'?`<div class="reveal">✓ Bonne réponse : ${esc(current.options[current.correctIndex] || '—')}</div>`:''}<div class="row between wrap spaced"><div><strong>${submissionsCount} / ${Object.keys(people).length}</strong> réponses reçues</div>${phase==='question'?`<button class="btn primary" data-action="reveal" ${busy?'disabled':''}>Afficher la réponse et les scores →</button>`:index+1<(sessionQuiz?.questions.length||0)?`<button class="btn primary" data-action="next" ${busy?'disabled':''}>Question suivante →</button>`:`<button class="btn primary" data-action="finish" ${busy?'disabled':''}>Terminer la partie →</button>`}</div></section>` : '<div class="loading">Chargement de la question…</div>';
  }
  if (phase === 'finished') content = `<section class="panel"><div class="center"><span class="kicker">Quiz terminé</span><div class="display-icon">🏆</div><h2 class="big-title">Congratulations!</h2><p>Classement final des participants</p></div>${leaderBoard(100)}</section>`;
  $app.innerHTML = top + `<div class="stage"><div class="stage-main">${content}</div><aside class="side"><section class="panel"><h2 class="teacher-panel-title">Participants <span class="pill">${Object.keys(people).length}</span></h2>${phase==='lobby'?`<div class="names">${Object.values(people).map(p=>`<span class="name-chip">${esc(p.name)}</span>`).join('')||'<span class="muted">En attente…</span>'}</div>`:leaderBoard(10)}</section><section class="panel"><h2 class="teacher-panel-title">Commandes</h2><p class="tiny muted">Garde cet onglet ouvert : c'est l'écran professeur qui calcule les scores et fait avancer le quiz.</p><button class="btn danger wide" data-action="delete-room">Supprimer la partie</button></section></aside></div>`;
  tickClock();
}
function answerHtml(text,i,correctIndex,chosenIndex,clickable) {
  const reveal = correctIndex !== null && correctIndex !== undefined;
  const good = reveal && i===correctIndex;
  const wrong = reveal && i!==correctIndex;
  const chosen = chosenIndex===i;
  return `<button type="button" class="answer a${i} ${good?'correct':''} ${wrong?'wrong':''} ${chosen?'chosen':''}" ${clickable?`data-action="answer" data-index="${i}"`:'disabled'}><span class="shape">${icons[i]}</span><span>${esc(text)}</span>${good?'<span aria-label="Bonne réponse" style="margin-left:auto">✓</span>':''}${chosen&&!good?'<span aria-label="Ta réponse" style="margin-left:auto">•</span>':''}</button>`;
}
function renderPlayer() {
  if (!meta) { $app.innerHTML='<div class="loading"><div class="spinner"></div><p>Connexion à la partie…</p></div>'; return; }
  const phase=meta.phase, current=currentRound(), index=Number(meta.questionIndex)||0;
  let content='';
  if (phase==='lobby') content=`<section class="card center"><span class="kicker">Salle ${esc(roomCode)}</span><div class="display-icon">✨</div><h1 class="big-title">Bienvenue, ${esc(myName)} !</h1><p>Tu as rejoint la partie. Le quiz commencera dès que le professeur sera prêt.</p><div class="count">${Object.keys(people).length}</div><span class="muted">joueurs dans la salle</span><div class="hr"></div><strong>${esc(meta.title)}</strong></section>`;
  if (phase==='question' && current) {
    const chosen = ownAnswer?.option ?? null;
    content = `<section class="panel"><div class="question-header"><span class="pill">Question ${index+1}</span><span id="timer" class="timer">${secondsLeft()??'–'} s</span></div><div class="bar"><span id="timerBar"></span></div><h1 class="question-title">${esc(current.question)}</h1><div class="answers">${current.options.map((opt,i)=>answerHtml(opt,i,null,chosen,chosen===null&&!submitting&&secondsLeft()>0)).join('')}</div><div class="center last-note" aria-live="polite">${chosen!==null?'✓ Réponse enregistrée. Attends les résultats.':submitting?'Envoi en cours…':secondsLeft()===0?'Temps écoulé. Attends les résultats.':'Appuie sur ta réponse avant la fin du temps.'}</div></section>`;
  }
  if (phase==='reveal' && current) {
    const chosen=ownAnswer?.option??null;
    const good=chosen===current.correctIndex;
    const rank=playersSorted().findIndex(p=>p.uid===user.uid)+1;
    content=`<section class="panel"><div class="center"><span class="kicker">Question ${index+1} terminée</span><div class="display-icon">${chosen===null?'⏳':good?'🎉':'📘'}</div><h1 class="big-title">${chosen===null?'Temps écoulé':good?'Bien joué !':'À retenir'}</h1><p class="muted">Bonne réponse : <strong>${esc(current.options[current.correctIndex] || '—')}</strong></p><div class="score-hero">${(scores[user.uid]?.points||0).toLocaleString('fr-FR')}</div><strong>points au total</strong><p>${rank ? `Position actuelle : ${rank} / ${Object.keys(people).length}` : 'Classement en cours de calcul…'}</p></div><div class="hr"></div><h2>Classement</h2>${leaderBoard(10,user.uid)}<p class="center last-note">Attends la prochaine question sur cet écran.</p></section>`;
  }
  if (phase==='finished') {
    const mine=playersSorted().find(p=>p.uid===user.uid);
    content=`<section class="panel"><div class="center"><span class="kicker">Fin de la partie</span><div class="display-icon">🏆</div><h1 class="big-title">Well played!</h1><p>${esc(myName)}, tu as obtenu</p><div class="score-hero">${(mine?.points||0).toLocaleString('fr-FR')}</div><strong>points</strong></div><div class="hr"></div>${leaderBoard(100,user.uid)}<div class="center spaced"><button class="btn soft" data-action="home">Retour à l'accueil</button></div></section>`;
  }
  if (!content) content='<div class="loading"><div class="spinner"></div><p>Chargement de la question…</p></div>';
  $app.innerHTML=`<div class="student-screen"><div class="row between wrap" style="margin-bottom:15px"><span class="kicker">${esc(meta.title)}</span><span class="pill">${esc(myName)}</span></div>${content}</div>`;
  tickClock();
}
function tickClock() {
  if (!meta || meta.phase!=='question') return;
  const remain=secondsLeft(), current=currentRound();
  if (remain===null || !current) return;
  const clock=document.getElementById('timer');
  if (clock) { clock.textContent=remain+' s'; clock.classList.toggle('urgent',remain<=5); }
  const bar=document.getElementById('timerBar');
  if (bar) bar.style.width=(Math.max(0,Math.min(100,100*remain/current.duration)))+'%';
}
setInterval(() => {
  if (meta?.phase!=='question') return;
  tickClock();
  if (role==='host' && secondsLeft()===0 && !busy && currentRound()?.status==='open') revealRound();
},250);

async function createRoom() {
  if (busy) return;
  const errors=validateQuiz(quiz);
  if (errors.length) { toast(errors[0]); return; }
  busy=true;
  try {
    await ensureReady();
    sessionQuiz=clone(quiz);
    let created=false;
    for (let retry=0;retry<8&&!created;retry++) {
      const code=numberCode(); const metaRef=db.ref(`rooms/${code}/meta`);
      if ((await metaRef.get()).exists()) continue;
      try {
        await metaRef.set({ownerUid:user.uid,title:sessionQuiz.title,duration:Number(sessionQuiz.duration),phase:'lobby',questionIndex:-1,currentKey:'none',createdAt:firebase.database.ServerValue.TIMESTAMP});
        roomCode=code; created=true;
      } catch (err) { if (err.code!=='PERMISSION_DENIED') throw err; }
    }
    if (!created) throw new Error('Impossible de créer un code disponible. Réessaie.');
    localStorage.setItem(STORAGE_ROOM,JSON.stringify({code:roomCode,quiz:sessionQuiz}));
    role='host'; connectRoom();
    toast('Salle créée. Partage le code avec tes élèves.');
  } catch(err) { toast(friendlyError(err)); }
  finally { busy=false; }
}
async function joinRoom() {
  if (joining) return;
  const code=(document.getElementById('joinCode')?.value||'').replace(/\D/g,'');
  const name=(document.getElementById('joinName')?.value||'').trim().replace(/\s+/g,' ');
  if (!/^\d{6}$/.test(code)) return toast('Saisis un code à six chiffres.');
  if (name.length<2||name.length>20) return toast('Choisis un pseudonyme entre 2 et 20 caractères.');
  joining=true;
  try {
    await ensureReady();
    const base=`rooms/${code}`;
    const roomMeta=(await db.ref(`${base}/meta`).get()).val();
    if (!roomMeta) throw new Error('Ce code ne correspond à aucune partie.');
    if (roomMeta.phase!=='lobby') throw new Error('La partie a déjà commencé ou est terminée.');
    const participantRef=db.ref(`${base}/participants/${user.uid}`);
    const prior=(await participantRef.get()).val();
    if (prior) myName=prior.name;
    else {
      const everyone=(await db.ref(`${base}/participants`).get()).val()||{};
      if (Object.values(everyone).some(p=>(p.name||'').toLocaleLowerCase('fr')===name.toLocaleLowerCase('fr'))) throw new Error('Ce pseudonyme est déjà utilisé. Choisis-en un autre.');
      await participantRef.set({name,joinedAt:firebase.database.ServerValue.TIMESTAMP});
      myName=name;
    }
    roomCode=code; role='player'; connectRoom();
    history.replaceState(null,'',joinLink());
  } catch(err) { toast(friendlyError(err)); }
  finally { joining=false; if(role==='joining')render(); }
}
async function publishNext() {
  if (busy || !meta || role!=='host' || !['lobby','reveal'].includes(meta.phase)) return;
  if (Object.keys(people).length===0) return toast('Attends au moins un élève avant de commencer.');
  const next=meta.phase==='lobby'?0:Number(meta.questionIndex)+1;
  if (next >= sessionQuiz.questions.length) return finishRoom();
  busy=true;
  try {
    const q=sessionQuiz.questions[next];
    await db.ref(`rooms/${roomCode}/rounds/${next}`).set({question:q.text,options:q.options,duration:Number(sessionQuiz.duration),startedAt:firebase.database.ServerValue.TIMESTAMP,status:'open'});
    await db.ref(`rooms/${roomCode}/meta`).update({phase:'question',questionIndex:next,currentKey:String(next)});
    meta={...meta,phase:'question',questionIndex:next,currentKey:String(next)};
  } catch(err) { toast(friendlyError(err)); }
  finally { busy=false; render(); }
}
function scorePoints(answer,round) {
  if (!answer || answer.option!==round.correctIndex || typeof answer.answeredAt!=='number' || typeof round.startedAt!=='number') return 0;
  const elapsed=answer.answeredAt-round.startedAt;
  if (elapsed<0 || elapsed>round.duration*1000) return 0;
  return 500+Math.round(500*(1-elapsed/(round.duration*1000)));
}
async function revealRound() {
  if (busy||role!=='host'||meta?.phase!=='question') return;
  const index=Number(meta.questionIndex), q=sessionQuiz?.questions[index];
  if (!q) return toast('Corrigé du professeur introuvable. Recharge cet écran sur le navigateur qui a créé la partie.');
  busy=true;
  try {
    const base=`rooms/${roomCode}`;
    await db.ref(`${base}/rounds/${index}`).update({status:'closed',correctIndex:q.correct});
    // Recalcule tous les scores depuis les réponses brutes. Opération idempotente :
    // fermer/recharger deux fois une manche ne peut pas attribuer les points deux fois.
    const [rSnap,aSnap,pSnap]=await Promise.all([db.ref(`${base}/rounds`).get(),db.ref(`${base}/submissions`).get(),db.ref(`${base}/participants`).get()]);
    const completed=rSnap.val()||{}, answers=aSnap.val()||{}, roster=pSnap.val()||{};
    const totals={};
    for(const uid of Object.keys(roster)) totals[uid]={points:0,correct:0};
    for(const [roundKey,round] of Object.entries(completed)) {
      if(round.status!=='closed'||!Number.isInteger(round.correctIndex))continue;
      for(const [uid,entry] of Object.entries(answers[roundKey]||{})) {
        if(!totals[uid])continue;
        const gained=scorePoints(entry,round);
        if(gained>0){totals[uid].points+=gained;totals[uid].correct+=1;}
      }
    }
    await db.ref(`${base}/scores`).set(totals);
    await db.ref(`${base}/meta`).update({phase:'reveal'});
    meta={...meta,phase:'reveal'};
  } catch(err){toast(friendlyError(err));}
  finally{busy=false;render();}
}
async function finishRoom() {
  if(busy||role!=='host'||meta?.phase!=='reveal')return;
  busy=true;
  try { await db.ref(`rooms/${roomCode}/meta`).update({phase:'finished'}); meta={...meta,phase:'finished'}; }
  catch(err){toast(friendlyError(err));}
  finally{busy=false;render();}
}
async function deleteRoom() {
  if(role!=='host'||!roomCode||busy)return;
  if(!confirm('Supprimer cette partie et toutes les réponses enregistrées ? Cette action est définitive.'))return;
  busy=true;
  try {
    const base=`rooms/${roomCode}`;
    for(const key of ['submissions','rounds','scores','participants','meta']) await db.ref(`${base}/${key}`).remove();
    localStorage.removeItem(STORAGE_ROOM); exitRoom(); history.replaceState(null,'',baseLink()); toast('Partie supprimée.');
  } catch(err){toast(friendlyError(err));}
  finally{busy=false;}
}
async function submitAnswer(index) {
  if(submitting||ownAnswer||role!=='player'||meta?.phase!=='question'||secondsLeft()<=0)return;
  submitting=true; render();
  try { await db.ref(`rooms/${roomCode}/submissions/${meta.currentKey}/${user.uid}`).set({option:index,answeredAt:firebase.database.ServerValue.TIMESTAMP}); }
  catch(err){toast(friendlyError(err));}
  finally{submitting=false;render();}
}
function exportQuiz() {
  const text=JSON.stringify(quiz,null,2);
  const url=URL.createObjectURL(new Blob([text],{type:'application/json;charset=utf-8'}));
  const anchor=document.createElement('a');anchor.href=url;anchor.download='QuizAnglaisPersonnalise.json';anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),500);
}
async function importQuiz(file) {
  if(!file)return;
  try {
    const contents=await file.text();
    const incoming=JSON.parse(contents);
    const errors=validateQuiz(incoming);
    if(errors.length) throw new Error(errors[0]);
    quiz={title:incoming.title,duration:Number(incoming.duration),questions:incoming.questions.map(q=>({text:q.text,options:[...q.options],correct:q.correct}))};
    saveQuiz();render();toast('Quiz importé : '+quiz.questions.length+' questions.');
  }catch(err){toast('Impossible d’importer ce fichier : '+friendlyError(err));}
}

$app.addEventListener('click',async ev=>{
  const button=ev.target.closest('[data-action]');if(!button||button.disabled)return;
  const action=button.dataset.action;
  if(action==='editor'){role='editor';render();}
  else if(action==='go-join'){const input=document.getElementById('homeCode');const code=(input?.value||'').replace(/\D/g,'');history.replaceState(null,'',baseLink()+(code?'?join='+encodeURIComponent(code):''));role='joining';render();}
  else if(action==='home'){exitRoom();history.replaceState(null,'',baseLink());}
  else if(action==='add-question'){if(quiz.questions.length>=40)return toast('Maximum : 40 questions.');quiz.questions.push({text:'',options:['','','',''],correct:0});saveQuiz();render();}
  else if(action==='delete-question'){if(quiz.questions.length>1){quiz.questions.splice(Number(button.dataset.index),1);saveQuiz();render();}}
  else if(action==='export')exportQuiz();
  else if(action==='create')await createRoom();
  else if(action==='join')await joinRoom();
  else if(action==='start'||action==='next')await publishNext();
  else if(action==='reveal')await revealRound();
  else if(action==='finish')await finishRoom();
  else if(action==='delete-room')await deleteRoom();
  else if(action==='answer')await submitAnswer(Number(button.dataset.index));
  else if(action==='copy-link'){
    try{await navigator.clipboard.writeText(joinLink());toast('Lien de connexion copié.');}
    catch(_){toast('Copie ce lien : '+joinLink());}
  }
});
$app.addEventListener('input',ev=>{
  const t=ev.target;
  if(role!=='editor')return;
  if(t.dataset.quizField==='title')quiz.title=t.value;
  else if(t.dataset.questionField==='text')quiz.questions[Number(t.dataset.index)].text=t.value;
  else if(t.dataset.option!==undefined)quiz.questions[Number(t.dataset.index)].options[Number(t.dataset.option)]=t.value;
  else return;
  saveQuiz();
});
$app.addEventListener('change',ev=>{
  const t=ev.target;
  if(t.id==='importFile'){importQuiz(t.files?.[0]);return;}
  if(role!=='editor')return;
  if(t.dataset.quizField==='duration')quiz.duration=Number(t.value);
  if(t.dataset.questionField==='correct')quiz.questions[Number(t.dataset.index)].correct=Number(t.value);
  saveQuiz();
});
$app.addEventListener('keydown',ev=>{
  if(ev.key==='Enter'&&['homeCode','joinCode','joinName'].includes(ev.target.id)){
    ev.preventDefault();if(role==='home')$app.querySelector('[data-action="go-join"]')?.click();if(role==='joining')$app.querySelector('[data-action="join"]')?.click();
  }
});

render();initFirebase();
