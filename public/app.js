/**
 * 匿名リアルタイムチャット - スマホ完全適応 クライアントスクリプト
 */

(() => {
  'use strict';

  // ==========================================
  // 定数 & ランダムデータ
  // ==========================================
  const ADJECTIVES = [
    '旅する', '真夜中の', 'のんびり', '宇宙の', 'ひだまりの',
    '気まぐれ', '疾風の', 'ほのぼの', '眠れる', 'ハッピーな',
    '静かなる', '路地裏の', 'そよ風の', '星降る', 'ふわふわ'
  ];
  const NOUNS = [
    'トラネコ', 'キツネ', 'ペンギン', 'フクロウ', 'パンダ',
    '柴犬', 'イルカ', 'カピバラ', 'コアラ', 'リス',
    'ウサギ', 'ハムスター', 'ラッコ', 'ヒツジ', 'ハリネズミ'
  ];
  const AVATARS = ['🐱', '🦊', '🐼', '🦉', '🚀', '⚡', '🍀', '👾', '☕', '🔥'];

  // ==========================================
  // 状態管理
  // ==========================================
  const state = {
    clientId: localStorage.getItem('anon_chat_client_id') || generateId(),
    nickname: localStorage.getItem('anon_chat_nickname') || '',
    avatar: localStorage.getItem('anon_chat_avatar') || '🐱',
    soundEnabled: localStorage.getItem('anon_chat_sound') !== 'false',
    eventSource: null,
    isJoined: false,
    renderedMsgIds: new Set(),
    activeReactionPopover: null,
    audioCtx: null
  };

  localStorage.setItem('anon_chat_client_id', state.clientId);

  // ==========================================
  // DOM要素
  // ==========================================
  const mobileFrame = document.getElementById('mobileFrame');
  const joinModal = document.getElementById('joinModal');
  const nicknameInput = document.getElementById('nicknameInput');
  const charCount = document.getElementById('charCount');
  const previewAvatar = document.getElementById('previewAvatar');
  const avatarPicker = document.getElementById('avatarPicker');
  const randomNameBtn = document.getElementById('randomNameBtn');
  const btnJoinRoom = document.getElementById('btnJoinRoom');

  const onlineBadge = document.getElementById('onlineBadge');
  const myProfileIcon = document.getElementById('myProfileIcon');
  const soundIcon = document.getElementById('soundIcon');
  const btnToggleSound = document.getElementById('btnToggleSound');
  const btnShowQr = document.getElementById('btnShowQr');
  const btnEditProfile = document.getElementById('btnEditProfile');

  const messagesViewport = document.getElementById('messagesViewport');
  const messagesList = document.getElementById('messagesList');
  const btnScrollBottom = document.getElementById('btnScrollBottom');
  const quickChips = document.getElementById('quickChips');

  const chatForm = document.getElementById('chatForm');
  const messageInput = document.getElementById('messageInput');
  const btnSend = document.getElementById('btnSend');

  const qrModal = document.getElementById('qrModal');
  const btnCloseQr = document.getElementById('btnCloseQr');
  const qrContainer = document.getElementById('qrContainer');
  const mobileUrlText = document.getElementById('mobileUrlText');
  const btnCopyUrl = document.getElementById('btnCopyUrl');

  const btnFrameMode = document.getElementById('btnFrameMode');
  const btnFullMode = document.getElementById('btnFullMode');

  // ==========================================
  // ユーティリティ
  // ==========================================
  function generateId() {
    return 'u_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
  }

  function getRandomName() {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    return `${adj}${noun}`;
  }

  function formatTime(timestamp) {
    const d = new Date(timestamp || Date.now());
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function isTouchDevice() {
    return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) || window.matchMedia('(pointer: coarse)').matches;
  }

  // ==========================================
  // Web Audio API による効果音生成 (外部依存ゼロ)
  // ==========================================
  function playSound(type) {
    if (!state.soundEnabled) return;
    try {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtxClass) return;
      if (!state.audioCtx) {
        state.audioCtx = new AudioCtxClass();
      }
      if (state.audioCtx.state === 'suspended') {
        state.audioCtx.resume();
      }

      const ctx = state.audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      const now = ctx.currentTime;

      if (type === 'send') {
        // ポップな送信音
        osc.type = 'sine';
        osc.frequency.setValueAtTime(420, now);
        osc.frequency.exponentialRampToValueAtTime(840, now + 0.1);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
        osc.start(now);
        osc.stop(now + 0.12);
      } else if (type === 'receive') {
        // 優しく響く受信音
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(587.33, now); // D5
        osc.frequency.setValueAtTime(880, now + 0.08); // A5
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
        osc.start(now);
        osc.stop(now + 0.25);
      } else if (type === 'react') {
        // キラッとしたリアクション音
        osc.type = 'sine';
        osc.frequency.setValueAtTime(700, now);
        osc.frequency.exponentialRampToValueAtTime(1200, now + 0.15);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
        osc.start(now);
        osc.stop(now + 0.15);
      }
    } catch (e) {
      console.warn('Audio play error:', e);
    }
  }

  // ==========================================
  // プロフィール & 入室フロー
  // ==========================================
  function initProfileUI() {
    if (state.nickname) {
      nicknameInput.value = state.nickname;
      charCount.textContent = `${state.nickname.length}/15`;
    } else {
      nicknameInput.value = getRandomName();
      charCount.textContent = `${nicknameInput.value.length}/15`;
    }

    previewAvatar.textContent = state.avatar;
    myProfileIcon.textContent = state.avatar;

    // アバター選択
    avatarPicker.querySelectorAll('.avatar-opt').forEach(btn => {
      if (btn.dataset.avatar === state.avatar) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
      btn.addEventListener('click', () => {
        avatarPicker.querySelectorAll('.avatar-opt').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.avatar = btn.dataset.avatar;
        previewAvatar.textContent = state.avatar;
        myProfileIcon.textContent = state.avatar;
      });
    });

    // 🎲 おまかせ名前ボタン
    randomNameBtn.addEventListener('click', () => {
      nicknameInput.value = getRandomName();
      charCount.textContent = `${nicknameInput.value.length}/15`;
      nicknameInput.focus();
    });

    // ニックネーム入力監視
    nicknameInput.addEventListener('input', () => {
      charCount.textContent = `${nicknameInput.value.length}/15`;
    });

    // 入室ボタン
    btnJoinRoom.addEventListener('click', joinChatRoom);
    nicknameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        joinChatRoom();
      }
    });

    // サウンドトグル
    updateSoundIcon();
    btnToggleSound.addEventListener('click', () => {
      state.soundEnabled = !state.soundEnabled;
      localStorage.setItem('anon_chat_sound', state.soundEnabled);
      updateSoundIcon();
    });

    // プロフィール再編集
    btnEditProfile.addEventListener('click', () => {
      joinModal.classList.remove('hide');
      nicknameInput.focus();
    });
  }

  function updateSoundIcon() {
    soundIcon.textContent = state.soundEnabled ? '🔔' : '🔕';
  }

  async function joinChatRoom() {
    const rawNick = nicknameInput.value.trim();
    state.nickname = rawNick || '名無し';
    localStorage.setItem('anon_chat_nickname', state.nickname);
    localStorage.setItem('anon_chat_avatar', state.avatar);

    joinModal.classList.add('hide');
    state.isJoined = true;
    
    // PCの場合のみ自動フォーカス（スマホではキーボードが急に開いてガタつくのを防止）
    if (!isTouchDevice()) {
      setTimeout(() => messageInput.focus(), 150);
    }

    try {
      await fetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: state.clientId,
          nickname: state.nickname,
          avatar: state.avatar
        })
      });
    } catch (e) {
      console.warn('Join error:', e);
    }
  }

  // ==========================================
  // SSE リアルタイム接続 (自己修復・ウォッチドッグ付き)
  // ==========================================
  let lastEventTime = Date.now();

  function connectSSE() {
    if (state.eventSource) {
      try { state.eventSource.close(); } catch (e) {}
    }

    const url = `/api/stream?clientId=${encodeURIComponent(state.clientId)}`;
    const es = new EventSource(url);
    state.eventSource = es;
    lastEventTime = Date.now();

    es.onopen = () => {
      onlineBadge.textContent = '接続完了';
      lastEventTime = Date.now();
    };

    es.onmessage = (event) => {
      lastEventTime = Date.now();
      try {
        const data = jsonParse(event.data);
        if (!data) return;
        handleServerEvent(data);
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    };

    es.onerror = () => {
      onlineBadge.textContent = '再接続中...';
      lastEventTime = Date.now();
    };
  }

  // 画面復帰時や通信瞬断時の履歴差分自動同期
  async function syncHistory() {
    try {
      const res = await fetch('/api/history');
      const data = await res.json();
      if (data && data.messages) {
        let hasNew = false;
        data.messages.forEach(msg => {
          if (!state.renderedMsgIds.has(msg.id)) {
            appendMessage(msg, false);
            hasNew = true;
          }
        });
        if (hasNew) {
          handleAutoScroll();
        }
      }
      if (data && data.onlineCount !== undefined) {
        updateOnlineCount(data.onlineCount);
      }
    } catch (e) {
      console.warn('Sync history error:', e);
    }
  }

  // スマホ画面ロック解除・別アプリ復帰時の自動再同期
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      lastEventTime = Date.now();
      if (!state.eventSource || state.eventSource.readyState === EventSource.CLOSED) {
        connectSSE();
      } else {
        syncHistory();
      }
    }
  });

  // 通信ゾンビ化防止ウォッチドッグ (25秒以上無反応なら自動再接続)
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastEventTime > 25000) {
      lastEventTime = Date.now();
      connectSSE();
    }
  }, 5000);

  function jsonParse(str) {
    try {
      return JSON.parse(str);
    } catch (e) {
      return null;
    }
  }

  function handleServerEvent(data) {
    if (data.onlineCount !== undefined) {
      updateOnlineCount(data.onlineCount);
    }

    if (data.type === 'init') {
      // 過去履歴の一括表示
      messagesList.innerHTML = '';
      state.renderedMsgIds.clear();
      (data.history || []).forEach(msg => appendMessage(msg, false));
      scrollToBottom(false);
    } else if (data.type === 'message') {
      const isMine = data.message.clientId === state.clientId;
      appendMessage(data.message, true);
      if (!isMine) {
        playSound('receive');
      }
    } else if (data.type === 'system') {
      appendSystemMessage(data.text);
    } else if (data.type === 'reaction') {
      updateMessageReaction(data.messageId, data.emoji, data.count);
    }
  }

  function updateOnlineCount(count) {
    onlineBadge.textContent = `${count}人が参加中`;
  }

  // ==========================================
  // メッセージ描画
  // ==========================================
  function appendMessage(msg, shouldAnimate = true) {
    if (state.renderedMsgIds.has(msg.id)) {
      // 既存メッセージの更新（リアクション等）
      const existing = document.getElementById(`msg-${msg.id}`);
      if (existing) renderReactions(existing, msg.id, msg.reactions);
      return;
    }

    state.renderedMsgIds.add(msg.id);

    const isMine = msg.clientId === state.clientId;
    const row = document.createElement('div');
    row.id = `msg-${msg.id}`;
    row.className = `msg-row ${isMine ? 'me' : 'other'}`;
    if (!shouldAnimate) row.style.animation = 'none';

    const timeStr = formatTime(msg.timestamp);

    if (isMine) {
      row.innerHTML = `
        <div class="msg-body-wrapper">
          <div class="msg-bubble" data-msg-id="${msg.id}">
            ${escapeHtml(msg.text)}
          </div>
          <div class="reactions-list" id="reactions-${msg.id}"></div>
          <div class="msg-meta">
            <span>${timeStr}</span>
            <span>✓</span>
          </div>
        </div>
      `;
    } else {
      row.innerHTML = `
        <div class="msg-avatar">${escapeHtml(msg.avatar || '🐱')}</div>
        <div class="msg-body-wrapper">
          <span class="msg-sender-name">${escapeHtml(msg.nickname || '名無し')}</span>
          <div class="msg-bubble" data-msg-id="${msg.id}">
            ${escapeHtml(msg.text)}
          </div>
          <div class="reactions-list" id="reactions-${msg.id}"></div>
          <div class="msg-meta">
            <span>${timeStr}</span>
          </div>
        </div>
      `;
    }

    // リアクション初期表示
    renderReactions(row, msg.id, msg.reactions);

    // メッセージタップでリアクションメニュー展開
    const bubble = row.querySelector('.msg-bubble');
    bubble.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleReactionPopover(bubble, msg.id, isMine);
    });

    messagesList.appendChild(row);

    // 自分が送信したメッセージは必ず最下部まで追従
    if (isMine) {
      scrollToBottom(true);
    } else {
      handleAutoScroll();
    }
  }

  function appendSystemMessage(text) {
    const el = document.createElement('div');
    el.className = 'msg-system';
    el.textContent = text;
    messagesList.appendChild(el);
    handleAutoScroll();
  }

  // ==========================================
  // クイックリアクション機能
  // ==========================================
  const QUICK_EMOJIS = ['👍', '❤️', '🔥', '😂', '👏', '🎉'];

  function toggleReactionPopover(bubbleEl, msgId, isMine) {
    closeReactionPopover();

    const popover = document.createElement('div');
    popover.className = `reaction-popover ${isMine ? 'right' : 'left'}`;

    QUICK_EMOJIS.forEach(emoji => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-quick-react';
      btn.textContent = emoji;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        sendReaction(msgId, emoji);
        closeReactionPopover();
      });
      popover.appendChild(btn);
    });

    bubbleEl.appendChild(popover);
    state.activeReactionPopover = popover;
  }

  function closeReactionPopover() {
    if (state.activeReactionPopover) {
      state.activeReactionPopover.remove();
      state.activeReactionPopover = null;
    }
  }

  document.addEventListener('click', () => {
    closeReactionPopover();
  });

  async function sendReaction(msgId, emoji) {
    playSound('react');
    try {
      await fetch('/api/react', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: msgId, emoji })
      });
    } catch (e) {
      console.warn('React error:', e);
    }
  }

  function updateMessageReaction(msgId, emoji, count) {
    const row = document.getElementById(`msg-${msgId}`);
    if (!row) return;
    const reactionsBox = row.querySelector(`#reactions-${msgId}`);
    if (!reactionsBox) return;

    let badge = reactionsBox.querySelector(`[data-emoji="${emoji}"]`);
    if (badge) {
      badge.querySelector('.count').textContent = count;
    } else {
      badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'reaction-badge';
      badge.dataset.emoji = emoji;
      badge.innerHTML = `<span>${emoji}</span> <span class="count">${count}</span>`;
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        sendReaction(msgId, emoji);
      });
      reactionsBox.appendChild(badge);
    }
  }

  function renderReactions(rowEl, msgId, reactionsObj) {
    if (!reactionsObj) return;
    const reactionsBox = rowEl.querySelector(`#reactions-${msgId}`);
    if (!reactionsBox) return;

    reactionsBox.innerHTML = '';
    Object.entries(reactionsObj).forEach(([emoji, count]) => {
      if (count > 0) {
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = 'reaction-badge';
        badge.dataset.emoji = emoji;
        badge.innerHTML = `<span>${emoji}</span> <span class="count">${count}</span>`;
        badge.addEventListener('click', (e) => {
          e.stopPropagation();
          sendReaction(msgId, emoji);
        });
        reactionsBox.appendChild(badge);
      }
    });
  }

  // ==========================================
  // スクロール制御 (スマホ最適化)
  // ==========================================
  function isNearBottom() {
    const threshold = 200; // px (ログ増加時も滑らかに追従)
    const position = messagesViewport.scrollTop + messagesViewport.clientHeight;
    return (messagesViewport.scrollHeight - position) <= threshold;
  }

  function scrollToBottom(smooth = true) {
    messagesViewport.scrollTo({
      top: messagesViewport.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto'
    });
    btnScrollBottom.classList.add('hide');
  }

  function handleAutoScroll() {
    if (isNearBottom()) {
      scrollToBottom(true);
    } else {
      btnScrollBottom.classList.remove('hide');
    }
  }

  messagesViewport.addEventListener('scroll', () => {
    if (isNearBottom()) {
      btnScrollBottom.classList.add('hide');
    }
  });

  btnScrollBottom.addEventListener('click', () => {
    scrollToBottom(true);
  });

  // ==========================================
  // メッセージ送信ロジック (二重送信防止・IME確定対応)
  // ==========================================
  let isSending = false;

  async function sendMessage(text) {
    if (isSending) return;

    // 引数または現在のテキストエリアから取得
    const rawText = text !== undefined ? text : messageInput.value;
    const cleanText = rawText.trim();
    if (!cleanText) return;

    // 即座にロック & 入力クリア
    isSending = true;
    messageInput.value = '';
    messageInput.style.height = 'auto';
    btnSend.disabled = true;

    playSound('send');

    const msgId = 'm_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);

    try {
      await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: state.clientId,
          nickname: state.nickname || '名無し',
          avatar: state.avatar || '🐱',
          text: cleanText,
          msgId: msgId
        })
      });
    } catch (err) {
      console.error('Send message failed:', err);
    } finally {
      // 300msのクールダウンを設けて連続タップ・誤連打による二重送信を完全防止
      setTimeout(() => {
        isSending = false;
        btnSend.disabled = !messageInput.value.trim();
      }, 300);
    }
  }

  // フォーム送信イベント（送信ボタンタップなど）
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage();
  });

  // 日本語入力中（IME変換中）フラグ管理
  let isComposingIME = false;

  messageInput.addEventListener('compositionstart', () => {
    isComposingIME = true;
  });

  messageInput.addEventListener('compositionend', () => {
    // 確定直後のkeydownでEnterが拾われないよう安全マージン
    setTimeout(() => {
      isComposingIME = false;
    }, 60);
  });

  // キーボードイベント（PCでのEnter送信、スマホでの改行許可）
  messageInput.addEventListener('keydown', (e) => {
    // 日本語変換・確定操作中は絶対に送信させない
    if (e.isComposing || isComposingIME || e.keyCode === 229) {
      return;
    }

    // スマホ・タッチ端末では Enter は通常の「改行」として扱い、誤送信を防止（送信は右の紙飛行機ボタン）
    if (isTouchDevice()) {
      return;
    }

    // PC/物理キーボードの場合: Enterで送信、Shift+Enterで改行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  messageInput.addEventListener('input', () => {
    // 高さ自動調整
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
    btnSend.disabled = isSending || !messageInput.value.trim();
  });

  // クイック定型文チップス
  quickChips.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      sendMessage(chip.textContent);
    });
  });

  // ==========================================
  // スマホ仮想キーボード & Viewport 追従 (iOS Safari / Android完全適応)
  // ==========================================
  function updateViewport() {
    if (!window.visualViewport) return;

    // PC大画面表示（横幅900px超）かつ枠固定モードの場合は除外
    if (window.innerWidth <= 900 || mobileFrame.classList.contains('full-screen-mode')) {
      const vp = window.visualViewport;
      const vpHeight = Math.round(vp.height);
      const winHeight = window.innerHeight;
      const isKeyboard = (winHeight - vpHeight) > 120 || document.activeElement === messageInput;

      // 高さをVisualViewportに厳密に合わせる
      document.documentElement.style.setProperty('--app-height', `${vpHeight}px`);

      if (isKeyboard) {
        document.body.classList.add('keyboard-open');
        mobileFrame.classList.add('keyboard-open');
        // iOS Safariがページ全体をスクロールしてヘッダーを飛ばしてしまうのを抑制
        window.scrollTo(0, 0);
        setTimeout(() => {
          scrollToBottom(false);
        }, 30);
      } else {
        document.body.classList.remove('keyboard-open');
        mobileFrame.classList.remove('keyboard-open');
      }
    }
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateViewport);
    window.visualViewport.addEventListener('scroll', () => {
      // 仮想キーボード表示中の意図しないWindow全体スクロールをリセット
      if (document.body.classList.contains('keyboard-open')) {
        window.scrollTo(0, 0);
      }
    });
  }

  messageInput.addEventListener('focus', () => {
    document.body.classList.add('keyboard-open');
    mobileFrame.classList.add('keyboard-open');
    updateViewport();
    setTimeout(() => {
      window.scrollTo(0, 0);
      scrollToBottom(true);
    }, 120);
  });

  messageInput.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement !== messageInput) {
        document.body.classList.remove('keyboard-open');
        mobileFrame.classList.remove('keyboard-open');
        document.documentElement.style.setProperty('--app-height', '100dvh');
        window.scrollTo(0, 0);
      }
    }, 150);
  });

  // ==========================================
  // 実機スマホ連携 (QRコード表示)
  // ==========================================
  async function loadServerInfo() {
    try {
      const res = await fetch('/api/info');
      const data = await res.json();
      mobileUrlText.value = data.mobileUrl;
      renderQRCode(data.mobileUrl);
    } catch (e) {
      const currentUrl = window.location.href;
      mobileUrlText.value = currentUrl;
      renderQRCode(currentUrl);
    }
  }

  function renderQRCode(url) {
    qrContainer.innerHTML = '';
    if (window.QRCode) {
      new window.QRCode(qrContainer, {
        text: url,
        width: 176,
        height: 176,
        colorDark: '#0b0f19',
        colorLight: '#ffffff',
        correctLevel: window.QRCode.CorrectLevel.M
      });
    } else {
      // フォールバック: テキストリンク表示
      qrContainer.innerHTML = `<p style="font-size:12px;color:#333;word-break:break-all;padding:10px;">${escapeHtml(url)}</p>`;
    }
  }

  btnShowQr.addEventListener('click', () => {
    loadServerInfo();
    qrModal.classList.remove('hide');
  });

  btnCloseQr.addEventListener('click', () => {
    qrModal.classList.add('hide');
  });

  btnCopyUrl.addEventListener('click', () => {
    mobileUrlText.select();
    navigator.clipboard.writeText(mobileUrlText.value).then(() => {
      const orig = btnCopyUrl.textContent;
      btnCopyUrl.textContent = '完了!';
      setTimeout(() => btnCopyUrl.textContent = orig, 1500);
    });
  });

  // ==========================================
  // PCプレビュー枠モード切替
  // ==========================================
  btnFrameMode.addEventListener('click', () => {
    btnFrameMode.classList.add('active');
    btnFullMode.classList.remove('active');
    mobileFrame.classList.remove('full-screen-mode');
  });

  btnFullMode.addEventListener('click', () => {
    btnFullMode.classList.add('active');
    btnFrameMode.classList.remove('active');
    mobileFrame.classList.add('full-screen-mode');
  });

  // ==========================================
  // ハートビート
  // ==========================================
  setInterval(async () => {
    if (!state.isJoined) return;
    try {
      await fetch('/api/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: state.clientId })
      });
    } catch (e) {
      // ping fail ignore
    }
  }, 20000);

  // ==========================================
  // 初期化起動
  // ==========================================
  initProfileUI();
  connectSSE();

})();
