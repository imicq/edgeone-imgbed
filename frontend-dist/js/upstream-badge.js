/**
 * 后台「系统版本」卡片上的上游更新提示
 *
 * 不碰打包好的 Vue 产物：Vue 渲染出 .overview-card.system-version 之后，
 * 这里在卡片底部补一行状态，说明上游 GitHub 有没有新版本、落后多少提交、
 * 有多少文件搬过来时需要适配。点击跳 GitHub 对比页。
 *
 * 数据来自 /api/manage/upstream（管理端接口，未登录会 401）。
 */
(function () {
  'use strict';

  if (window.__upstreamBadgeLoaded) return;
  window.__upstreamBadgeLoaded = true;

  var CARD_SELECTOR = '.overview-card.system-version';
  var BADGE_CLASS = 'upstream-badge';
  var state = { loading: false, data: null, at: 0 };

  var CSS = [
    '.system-version .' + BADGE_CLASS + '{margin-top:8px;display:flex;flex-wrap:wrap;align-items:center;gap:6px;',
    'font-size:12px;line-height:1.55;text-decoration:none;color:inherit;cursor:pointer;}',
    '.' + BADGE_CLASS + ' .ub-dot{width:6px;height:6px;border-radius:50%;background:#9aa3ad;flex:0 0 auto;}',
    '.' + BADGE_CLASS + '.is-new .ub-dot{background:#ff9f43;box-shadow:0 0 0 3px rgba(255,159,67,.16);}',
    '.' + BADGE_CLASS + '.is-latest .ub-dot{background:#35c07f;}',
    '.' + BADGE_CLASS + '.is-error .ub-dot{background:#e05b5b;}',
    '.' + BADGE_CLASS + '.is-incomplete .ub-dot{background:#d0a03a;}',
    '.' + BADGE_CLASS + ' .ub-text{font-weight:600;}',
    '.' + BADGE_CLASS + ' .ub-sub{opacity:.62;font-weight:400;}',
    '.' + BADGE_CLASS + ' .ub-refresh{opacity:.55;border:0;background:none;padding:0 0 0 2px;',
    'font:inherit;color:inherit;cursor:pointer;text-decoration:underline;}',
    '.' + BADGE_CLASS + ' .ub-refresh:hover{opacity:.9;}',
  ].join('');

  function ensureStyle() {
    if (document.getElementById('upstream-badge-style')) return;
    var style = document.createElement('style');
    style.id = 'upstream-badge-style';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function timeText(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function buildBadge(data) {
    var upstream = data && data.upstream;
    var current = (data && data.current) || {};
    var badge = document.createElement('a');
    badge.className = BADGE_CLASS;
    badge.rel = 'noopener noreferrer';
    badge.target = '_blank';

    var dot = document.createElement('span');
    dot.className = 'ub-dot';
    badge.appendChild(dot);

    var text = document.createElement('span');
    text.className = 'ub-text';

    var sub = document.createElement('span');
    sub.className = 'ub-sub';

    if (!upstream) {
      badge.classList.add('is-error');
      text.textContent = data && data.error ? '上游检测失败：' + data.error : '上游状态未知';
    } else if (upstream.status === 'incomplete' && !upstream.updateAvailable) {
      badge.classList.add('is-incomplete');
      text.textContent = '上游版本对比未取到';
      var reason = (upstream.compare && upstream.compare.error) ? upstream.compare.error : '请求受限';
      sub.textContent = '（' + reason + '）';
      badge.href = upstream.repoUrl ? upstream.repoUrl + '/commits/main' : '#';
    } else if (upstream.updateAvailable) {
      badge.classList.add('is-new');
      var releaseTag = upstream.release && upstream.release.tag ? upstream.release.tag : '';
      var headShort = upstream.head && upstream.head.shortSha ? upstream.head.shortSha : '';
      var releaseNewer = !!upstream.releaseIsNewer;
      var bits = [];
      if (releaseNewer) {
        // 真正的发版更新：版本号比我们高
        text.textContent = '上游有新版本 ' + releaseTag;
        if (upstream.commitsBehind > 0) bits.push('落后 ' + upstream.commitsBehind + ' 个提交');
      } else {
        // 版本号没动，但上游 main 已经往前跑了
        text.textContent = upstream.commitsBehind > 0
          ? '上游有 ' + upstream.commitsBehind + ' 个新提交'
          : '上游有新提交';
        if (releaseTag) bits.push('版本同为 ' + releaseTag + (headShort ? ' · main @ ' + headShort : ''));
      }
      var need = upstream.files && upstream.files.needAdaptCount;
      if (need > 0) bits.push(need + ' 个文件需适配');
      sub.textContent = bits.length ? '（' + bits.join(' · ') + '）' : '';
      badge.href = (upstream.compare && upstream.compare.url) ||
        (upstream.release && upstream.release.url) ||
        (upstream.repoUrl ? upstream.repoUrl + '/commits/main' : '#');
    } else {
      badge.classList.add('is-latest');
      text.textContent = '上游已是最新 ' + (upstream.release && upstream.release.tag ? upstream.release.tag : '');
      sub.textContent = '（基线 v' + (current.baselineVersion || current.version || '') + '）';
      badge.href = (upstream.release && upstream.release.url) || (upstream.repoUrl || '#');
    }

    badge.appendChild(text);
    if (sub.textContent) badge.appendChild(sub);

    var checked = timeText(upstream && upstream.checkedAt);
    if (checked) {
      var stamp = document.createElement('span');
      stamp.className = 'ub-sub';
      stamp.textContent = '· 检测于 ' + checked + (upstream && upstream.stale ? '（缓存）' : '');
      badge.appendChild(stamp);
    }

    // 卡片本身点击会打开 releases 页，这里拦掉冒泡，避免点徽标时顺手把后台跳走
    badge.addEventListener('click', function (event) {
      event.stopPropagation();
    });

    var refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'ub-refresh';
    refresh.textContent = '重新检测';
    refresh.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      load(true);
    });
    badge.appendChild(refresh);

    return badge;
  }

  function render(data) {
    var card = document.querySelector(CARD_SELECTOR);
    if (!card) return false;
    var old = card.querySelector('.' + BADGE_CLASS);
    var badge = buildBadge(data);
    if (old) {
      card.replaceChild(badge, old);
    } else {
      card.appendChild(badge);
      card.style.cursor = 'pointer';
    }
    return true;
  }

  function load(force) {
    if (state.loading) return;
    if (!force && state.data && Date.now() - state.at < 8000) return;
    state.loading = true;
    var url = '/api/manage/upstream' + (force ? '?refresh=1' : '');
    fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (res.status === 401 || res.status === 403) return null;
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        state.loading = false;
        if (!data) return;
        state.data = data;
        state.at = Date.now();
        render(data);
      })
      .catch(function () {
        state.loading = false;
      });
  }

  function start() {
    ensureStyle();
    if (document.querySelector(CARD_SELECTOR)) load(false);

    var scheduled = false;
    var observer = new MutationObserver(function () {
      if (scheduled) return;
      scheduled = true;
      setTimeout(function () {
        scheduled = false;
        var card = document.querySelector(CARD_SELECTOR);
        if (!card) return;
        // 卡片还在、徽标也在：说明是我们自己刚插的那条，直接返回，避免自触发死循环
        if (card.querySelector('.' + BADGE_CLASS)) return;
        if (state.data) {
          render(state.data);
        } else {
          load(false);
        }
      }, 400);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
