/**
 * UI 基础组件：悬停提示气泡、Toast、统一弹窗、复制到剪贴板、作者信息弹窗
 *
 * 从 uiManager.js 拆出（R162）。这些组件被数据集面板、图层面板、样式面板等共用，
 * 且不感知任何具体业务，因此独立成模块。
 *
 * 依赖：无（纯 DOM）
 */

const UIWidgets = (function() {

    // 打开弹窗前需要执行的清理（由宿主面板注册，例如关闭图层面板的浮层菜单）
    let beforeOpenHook = null;
    function setBeforeOpenHook(fn) {
        beforeOpenHook = (typeof fn === 'function') ? fn : null;
    }

    function initTooltips() {
        let tooltip = null;
        let activeElement = null;
        // R88：记录当前正在显示提示的 [data-tooltip] 元素，避免在同一元素与其子节点间移动时反复销毁重建（悬停闪烁的根因）
        let activeTooltipEl = null;

        const hideTooltip = function() {
            if (tooltip) tooltip.remove();
            tooltip = null;
            activeElement = null;
            activeTooltipEl = null;
        };

        const showTooltip = function(element) {
            const text = element.dataset.tooltip;
            if (!text) return;
            // 同一元素已在显示则不再重建，杜绝闪烁
            if (activeTooltipEl === element) return;
            hideTooltip();
            activeElement = element;
            activeTooltipEl = element;
            tooltip = document.createElement('div');
            // data-tooltip-wrap：长文本（如数据集完整介绍）用宽版换行气泡
            tooltip.className = 'app-tooltip' + (element.hasAttribute('data-tooltip-wrap') ? ' app-tooltip--wrap' : '');
            tooltip.textContent = text;
            document.body.appendChild(tooltip);

            const rect = element.getBoundingClientRect();
            const tooltipRect = tooltip.getBoundingClientRect();
            const gap = 8;
            let left = rect.left + (rect.width - tooltipRect.width) / 2;
            let top = rect.top - tooltipRect.height - gap;

            if (top < 8) top = rect.bottom + gap;
            // 上方放不下改放下方后，若下方也超出视口则贴住视口内（长文本气泡不会被截断）
            if (top + tooltipRect.height > window.innerHeight - 8) {
                top = Math.max(8, window.innerHeight - tooltipRect.height - 8);
            }
            left = Math.max(8, Math.min(left, window.innerWidth - tooltipRect.width - 8));
            tooltip.style.left = `${left}px`;
            tooltip.style.top = `${top}px`;
        };

        document.addEventListener('pointerover', event => {
            const element = event.target.closest?.('[data-tooltip]');
            if (element) showTooltip(element);
        });
        document.addEventListener('pointerout', event => {
            if (!activeTooltipEl) return;
            // 仅当指针离开当前提示元素、且未进入同一提示元素（含其子节点）时才隐藏
            const to = (event.relatedTarget && event.relatedTarget.closest)
                ? event.relatedTarget.closest('[data-tooltip]') : null;
            if (to !== activeTooltipEl) hideTooltip();
        });
        document.addEventListener('focusin', event => {
            const element = event.target.closest?.('[data-tooltip]');
            if (element) showTooltip(element);
        });
        document.addEventListener('focusout', hideTooltip);
        window.addEventListener('resize', hideTooltip);
        window.addEventListener('scroll', hideTooltip, true);
    }

    function showAppModal({ icon = 'fa-circle-question', title = '提示', message = '', confirmText = '确认', cancelText = '取消', danger = false, nowrap = false } = {}) {
        const overlay = document.getElementById('appModal');
        if (!overlay) return Promise.resolve(false);
        const card = overlay.querySelector('.app-modal');
        const titleEl = overlay.querySelector('#appModalTitle');
        const iconEl = overlay.querySelector('.app-modal-icon i');
        const body = overlay.querySelector('#appModalMessage');
        const cancelBtn = overlay.querySelector('#appModalCancel');
        const confirmBtn = overlay.querySelector('#appModalConfirm');
        if (!titleEl || !body || !cancelBtn || !confirmBtn) return Promise.resolve(false);

        titleEl.textContent = title;
        if (iconEl) {
            iconEl.className = `fas ${icon}`;
            iconEl.classList.toggle('danger', danger);
        }
        // textContent 避免内容被当作 HTML 解析；.app-modal-body 默认 white-space: pre-line，
        // message 里的 \n 会正常换行（多行指引直接用数组 join('\n') 即可）
        body.textContent = message;
        confirmBtn.textContent = confirmText;
        confirmBtn.classList.toggle('danger', danger);
        cancelBtn.textContent = cancelText || '';
        cancelBtn.hidden = !cancelText;
        // nowrap 时弹窗宽度按内容自适应（一行显示，不折行）
        if (card) card.classList.toggle('nowrap', nowrap);

        // 打开弹窗前关闭所有其它浮层（分组更多 / 底图 / 搜索等），
        // 具体关哪些由宿主面板通过 setBeforeOpenHook 注册，避免本模块反向依赖面板
        if (typeof beforeOpenHook === 'function') beforeOpenHook();

        overlay.hidden = false;
        document.body.classList.add('modal-open');

        return new Promise(resolve => {
            const cleanup = () => {
                overlay.hidden = true;
                document.body.classList.remove('modal-open');
                if (card) card.classList.remove('nowrap');
                cancelBtn.removeEventListener('click', onCancel);
                confirmBtn.removeEventListener('click', onConfirm);
                overlay.removeEventListener('click', onOverlay);
                document.removeEventListener('keydown', onKey);
            };
            const onCancel = () => { cleanup(); resolve(false); };
            const onConfirm = () => { cleanup(); resolve(true); };
            const onOverlay = (e) => { if (e.target === overlay) { cleanup(); resolve(false); } };
            const onKey = (e) => { if (e.key === 'Escape') { cleanup(); resolve(false); } };
            cancelBtn.addEventListener('click', onCancel);
            confirmBtn.addEventListener('click', onConfirm);
            overlay.addEventListener('click', onOverlay);
            document.addEventListener('keydown', onKey);
            confirmBtn.focus();
        });
    }

    // 以 file:// 直接打开时浏览器会拦截 fetch（CORS），manifest 与 geojson 全部读不到，
    // 表现为「数据集为空 / 搜索不可用」。此前只弹一句 toast，用户往往以为是程序坏了，
    // 这里给出明确的启动指引。
    function showStartupProtocolError() {
        return showAppModal({
            icon: 'fa-triangle-exclamation',
            title: '请通过本地服务器访问',
            message: [
                '当前是以文件方式（file://）直接打开的，浏览器出于安全策略会拦截数据读取，',
                '因此数据集列表为空、搜索功能也不可用。',
                '',
                '请在项目目录下启动一个本地服务器，例如：',
                '  · Python 3：  python -m http.server 8000',
                '  · Node.js：   npx serve',
                '',
                '然后在浏览器打开 http://localhost:8000 即可正常使用。',
            ].join('\n'),
            confirmText: '知道了',
            cancelText: '',
        });
    }

    // ---------- 复制到剪贴板（R59：邮箱点击复制，替代依赖邮件客户端的 mailto） ----------
    // 优先 Clipboard API（localhost/https secure context 可用），失败回退 execCommand
    function copyToClipboard(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(
                () => showToast(`已复制：${text}`, 'success'),
                () => fallbackCopy(text)
            );
        } else {
            fallbackCopy(text);
        }
    }

    function fallbackCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { /* 忽略 */ }
        document.body.removeChild(ta);
        showToast(ok ? `已复制：${text}` : '复制失败，请手动复制', ok ? 'success' : 'error');
    }

    // ---------- 作者信息弹窗（导航栏「关于作者」头像按钮打开） ----------
    // 内容来自 CONFIG.author，纯 textContent 渲染防注入；关闭：关闭按钮 / 知道了 / 遮罩 / Esc
    function showAuthorModal() {
        const overlay = document.getElementById('authorModal');
        if (!overlay) return;
        const author = (typeof CONFIG !== 'undefined' && CONFIG.author) || {};
        const nameEl = overlay.querySelector('#authorModalName');
        const avatarEl = overlay.querySelector('#authorAvatar');
        const taglineEl = overlay.querySelector('#authorModalTagline');
        const bioEl = overlay.querySelector('#authorModalBio');
        const websiteEl = overlay.querySelector('#authorModalWebsite');
        const detailsEl = overlay.querySelector('#authorModalDetails');
        if (nameEl) nameEl.textContent = author.name || '佚名';
        if (avatarEl) avatarEl.textContent = String(author.name || '?').trim().charAt(0);
        if (taglineEl) taglineEl.textContent = author.tagline || '';
        if (bioEl) bioEl.textContent = author.bio || '';
        if (websiteEl) websiteEl.textContent = author.website || '';
        if (detailsEl) {
            detailsEl.innerHTML = '';
            (author.details || []).forEach(detail => {
                const li = document.createElement('li');
                const icon = document.createElement('span');
                icon.className = 'detail-icon';
                const i = document.createElement('i');
                i.className = `fas ${detail.icon || 'fa-circle-info'}`;
                icon.appendChild(i);
                const text = document.createElement('span');
                text.className = 'detail-text';
                const label = document.createElement('span');
                label.className = 'detail-label';
                label.textContent = detail.label || '';
                const value = document.createElement('span');
                value.className = 'detail-value';
                value.textContent = detail.value || '';
                text.appendChild(label);
                text.appendChild(value);
                li.appendChild(icon);
                li.appendChild(text);
                detailsEl.appendChild(li);
            });
        }
        // 联系方式（R68 起按归属分列）：邮箱属作者 → 左列容器；GitHub 属项目 → 右列容器。
        // 邮箱点击复制到剪贴板（mailto 依赖邮件客户端不可靠）；外链新窗口。文本一律 textContent 防注入
        const contactAuthorEl = overlay.querySelector('#authorModalContactAuthor');
        const contactProjectEl = overlay.querySelector('#authorModalContactProject');
        // R72：每次打开必须先清空容器——R68 分流渲染后丢失了 innerHTML='' 清空，
        // 导致重复打开弹窗时邮箱/GitHub 累积 append、出现多次
        if (contactAuthorEl) contactAuthorEl.innerHTML = '';
        if (contactProjectEl) contactProjectEl.innerHTML = '';
        (author.contacts || []).forEach(contact => {
            const target = contact.side === 'project' ? contactProjectEl : contactAuthorEl;
            if (!target) return;
            const el = document.createElement(contact.action === 'copy' ? 'button' : 'a');
            if (contact.action === 'copy') el.type = 'button';
            el.className = 'contact-item' + (contact.action === 'copy' ? ' contact-copy' : '');
            if (contact.action === 'copy') {
                el.dataset.tooltip = '点击复制邮箱';
                el.setAttribute('aria-label', '复制邮箱地址');
                el.addEventListener('click', () => copyToClipboard(contact.value));
            } else {
                el.href = contact.href || '#';
                if (contact.href && contact.href.startsWith('http')) {
                    el.target = '_blank';
                    el.rel = 'noopener noreferrer';
                }
            }
            const icon = document.createElement('span');
            icon.className = 'detail-icon';
            const i = document.createElement('i');
            i.className = contact.icon || 'fas fa-circle-info';
            icon.appendChild(i);
            const text = document.createElement('span');
            text.className = 'contact-text';
            const label = document.createElement('span');
            label.className = 'contact-label';
            label.textContent = contact.label || '';
            const value = document.createElement('span');
            value.className = 'contact-value';
            value.textContent = contact.value || '';
            text.appendChild(label);
            text.appendChild(value);
            if (contact.desc) {
                const desc = document.createElement('span');
                desc.className = 'contact-desc';
                desc.textContent = contact.desc;
                text.appendChild(desc);
            }
            el.appendChild(icon);
            el.appendChild(text);
            target.appendChild(el);
        });

        overlay.hidden = false;
        document.body.classList.add('modal-open');
        const closeBtn = overlay.querySelector('#authorModalClose');
        const okBtn = overlay.querySelector('#authorModalOk');
        const cleanup = () => {
            overlay.hidden = true;
            document.body.classList.remove('modal-open');
            if (closeBtn) closeBtn.removeEventListener('click', onClose);
            if (okBtn) okBtn.removeEventListener('click', onClose);
            overlay.removeEventListener('click', onOverlay);
            document.removeEventListener('keydown', onKey);
        };
        const onClose = () => cleanup();
        const onOverlay = (e) => { if (e.target === overlay) cleanup(); };
        const onKey = (e) => { if (e.key === 'Escape') cleanup(); };
        if (closeBtn) closeBtn.addEventListener('click', onClose);
        if (okBtn) okBtn.addEventListener('click', onClose);
        overlay.addEventListener('click', onOverlay);
        document.addEventListener('keydown', onKey);
        if (okBtn) okBtn.focus();
    }

    function showToast(message, type = 'info', duration = 3000) {
        const container = document.getElementById('toastContainer');
        if (!container) return;

        // R88：提示消息出现在面板（侧边栏）右侧而非屏幕最右
        const sidebar = document.getElementById('sidebar');
        const sidebarOpen = sidebar && !sidebar.classList.contains('sidebar--collapsed');
        if (sidebarOpen) {
            const sbWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10) || 320;
            container.style.left = (sbWidth + 12) + 'px';
        } else {
            container.style.left = '12px';
        }
        container.style.right = 'auto';

        const icons = {
            success: 'fas fa-check-circle',
            error: 'fas fa-exclamation-circle',
            info: 'fas fa-info-circle',
            warning: 'fas fa-exclamation-triangle'
        };

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        const icon = document.createElement('i');
        icon.className = icons[type] || icons.info;
        const text = document.createElement('span');
        // textContent 避免消息内容被当作 HTML 解析
        text.textContent = message;
        toast.appendChild(icon);
        toast.appendChild(text);

        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    // ---------- 公开 API ----------
    return {
        initTooltips,
        showToast,
        showAppModal,
        showStartupProtocolError,
        showAuthorModal,
        copyToClipboard,
        setBeforeOpenHook,
    };

})();
