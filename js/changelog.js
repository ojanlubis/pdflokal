/*
 * ============================================================
 * PDFLokal - changelog.js
 * Changelog Notification System
 * ============================================================
 *
 * PURPOSE:
 *   Smart, non-intrusive notification badge for app updates.
 *   Self-contained IIFE — no external dependencies.
 *
 * GLOBAL API DEFINED HERE:
 *   - window.changelogAPI — Public: open(), minimize(), close(), hide(), restore()
 *   - window.changelogNextPage, window.changelogPrevPage — Pagination (HTML onclick)
 *   - localStorage key: 'pdflokal_changelog_last_closed'
 *
 * CONSUMED BY:
 *   - app.js calls changelogAPI.hide() / changelogAPI.restore() during navigation
 *   - pdf-tools.js calls changelogAPI.minimize() when opening modals
 *
 * LOAD ORDER: Must load BEFORE app.js (exposes window.changelogAPI)
 * ============================================================
 */

(function() {
  'use strict';

  // Changelog data - Add new updates at the beginning of the array
  const changelogData = [
    {
      title: "Keamanan Ditingkatkan! 🔒",
      description: "PDFLokal sekarang pakai security headers untuk perlindungan ekstra. Plus, ada halaman <a href=\"privasi.html\">Kebijakan Privasi</a> baru biar kamu lebih yakin data kamu aman. Intinya: file kamu tetap 100% di perangkat kamu, nggak kemana-mana!",
      date: "18 Januari 2026"
    },
    {
      title: "Bisa Dipakai Tanpa Internet! 📴",
      description: "PDFLokal sekarang bisa dipakai offline! Edit PDF, gabung, pisah, tanda tangan - semua bisa tanpa koneksi internet. Cocok buat kamu yang sering di tempat dengan sinyal lemah atau Wi-Fi kantor yang suka putus-putus. Catatan: fitur Proteksi PDF masih butuh internet.",
      date: "18 Januari 2026"
    },
    {
      title: "Penambahan mode gelap (Dark Mode)",
      description: "Sekarang PDFLokal punya mode gelap, lebih nyaman di mata buat kalian-kalian yang suka bekerja dalam kegelapan! 🦇🦇🦇 wkwk.",
      date: "12 Januari 2026"
    },    
    {
      title: "File PDF Kamu Jadi Lebih enteng!",
      description: "Sebelumnya ukuran PDF setelah ditambah tanda tangan sangat besar. Kami implementasi auto-compression biar tetap enteng. Download lebih cepat, hemat ruang penyimpanan.",
      date: "12 Januari 2026"
    },
    {
      title: "Tanda Tangan Lebih Mudah Diatur",
      description: "Tanda tangan yang terkunci bisa diunlock dan dipindahkan dengan klik dua kali. Bisa dihapus juga. Terima kasih <a href=\"https://github.com/hamdi1611\" target=\"_blank\">@hamdi1611</a>! 🙏",
      date: "11 Januari 2026"
    },
    {
      title: "Notifikasi Update di Pojok Layar",
      description: "Sekarang kamu bisa lihat update terbaru lewat badge merah di pojok kanan!",
      date: "11 Januari 2026"
    },
    {
      title: "Tetap Berfungsi di Restricted Networks",
      description: "PDFLokal sekarang bisa diakses di kantor/sekolah yang besar firewallnya! Semua font sudah tersedia offline. Privasi kamu lebih terjaga.",
      date: "11 Januari 2026"
    },
    {
      title: "Editor PDF Lebih Stabil",
      description: "Tidak ada lagi error saat export PDF atau pindah halaman. Kami perbaiki bug yang bikin aplikasi crash. Sekarang lebih lancar!",
      date: "11 Januari 2026"
    },
    {
      title: "Kunci PDF dengan Password Diperbaiki",
      description: "Fitur proteksi PDF dengan password sekarang bekerja dengan sempurna. File kamu lebih aman!",
      date: "5 Januari 2026"
    },
    {
      title: "Loading yang Lebih Jelas & Nama File Otomatis",
      description: "Sekarang ada indikator loading saat proses file besar, jadi kamu tahu aplikasi sedang bekerja. Nama file hasil download otomatis mengikuti file asli.",
      date: "5 Januari 2026"
    },
    {
      title: "Edit Teks Langsung di Canvas",
      description: "Sekarang kamu bisa resize teks, edit langsung (klik 2x), dan tekan Enter untuk langsung submit. Lebih cepat!",
      date: "4 Januari 2026"
    }
  ];

  // State
  let currentPage = 1;
  let currentState = 'hidden'; // 'hidden', 'expanded', 'collapsed'
  const itemsPerPage = 4;
  const totalPages = Math.ceil(changelogData.length / itemsPerPage);

  // Public API
  window.changelogAPI = {
    open: openChangelog,
    minimize: minimizeChangelog,
    close: closeChangelog,
    hide: hideChangelog,
    restore: restoreChangelog
  };

  /**
   * Initialize changelog on page load
   */
  function initChangelog() {
    // Get latest changelog entry title (unique identifier)
    const latestChangelogTitle = changelogData[0].title;

    // Get the title of the latest changelog user has closed
    const lastClosedTitle = localStorage.getItem('pdflokal_changelog_last_closed');

    // Update badge text with latest update
    const badgeTitle = document.querySelector('.changelog-badge-title');
    if (badgeTitle) {
      badgeTitle.textContent = 'Update Terbaru!';
    }

    // Determine initial state
    if (!lastClosedTitle) {
      // First-time visitor → Show collapsed badge
      showCollapsed();
    } else if (lastClosedTitle !== latestChangelogTitle) {
      // Returning visitor + NEW content available → Show collapsed badge
      showCollapsed();
    }
    // else: User already closed this version → Don't show anything (stays hidden)
  }

  /**
   * Show expanded changelog
   */
  function showExpanded() {
    const notification = document.getElementById('changelog-notification');
    if (!notification) return;

    notification.classList.add('active', 'expanded');
    notification.classList.remove('collapsed');
    currentState = 'expanded';

    // Reset to first page and render
    currentPage = 1;
    renderChangelog();
  }

  /**
   * Show collapsed badge
   */
  function showCollapsed() {
    const notification = document.getElementById('changelog-notification');
    if (!notification) return;

    notification.classList.add('active', 'collapsed');
    notification.classList.remove('expanded');
    currentState = 'collapsed';
  }

  /**
   * Open changelog (expand from badge)
   */
  function openChangelog() {
    showExpanded();
  }

  /**
   * Minimize changelog (collapse to badge)
   */
  function minimizeChangelog() {
    const notification = document.getElementById('changelog-notification');
    if (!notification) return;

    notification.classList.remove('expanded');
    notification.classList.add('collapsed');
    currentState = 'collapsed';

    // Mark latest changelog as closed (user has viewed it)
    const latestChangelogTitle = changelogData[0].title;
    localStorage.setItem('pdflokal_changelog_last_closed', latestChangelogTitle);
  }

  /**
   * Close changelog completely
   */
  function closeChangelog() {
    const notification = document.getElementById('changelog-notification');
    if (!notification) return;

    notification.classList.remove('active', 'expanded', 'collapsed');
    currentState = 'hidden';

    // Mark latest changelog as closed (user has closed it)
    const latestChangelogTitle = changelogData[0].title;
    localStorage.setItem('pdflokal_changelog_last_closed', latestChangelogTitle);
  }

  /**
   * Temporarily hide changelog (without changing localStorage)
   * Used when leaving home-view
   */
  function hideChangelog() {
    const notification = document.getElementById('changelog-notification');
    if (!notification) return;

    notification.classList.remove('active');
    // Don't change currentState, so we can restore it later
  }

  /**
   * Restore changelog to previous state based on localStorage
   * Used when returning to home-view
   */
  function restoreChangelog() {
    const latestChangelogTitle = changelogData[0].title;
    const lastClosedTitle = localStorage.getItem('pdflokal_changelog_last_closed');

    // If user has NEW content (or first visit), show badge
    if (lastClosedTitle && lastClosedTitle !== latestChangelogTitle) {
      showCollapsed();
    } else if (!lastClosedTitle) {
      // First visit, show badge
      showCollapsed();
    }
    // If already closed this version, don't show anything (stays hidden)
  }

  /**
   * Render changelog items for current page
   */
  function renderChangelog() {
    const content = document.getElementById('changelog-content');
    if (!content) return;

    const startIdx = (currentPage - 1) * itemsPerPage;
    const endIdx = Math.min(startIdx + itemsPerPage, changelogData.length);

    content.innerHTML = changelogData.slice(startIdx, endIdx).map(item => `
      <div class="changelog-item">
        <div class="changelog-item-header">
          <h4>${item.title}</h4>
          <span class="changelog-date">${item.date}</span>
        </div>
        <p class="changelog-description">${item.description}</p>
      </div>
    `).join('');

    // Update pagination
    const pageInfo = document.getElementById('changelog-page-info');
    const prevBtn = document.getElementById('changelog-prev-btn');
    const nextBtn = document.getElementById('changelog-next-btn');

    if (pageInfo) pageInfo.textContent = `${currentPage} / ${totalPages}`;
    if (prevBtn) prevBtn.disabled = currentPage === 1;
    if (nextBtn) nextBtn.disabled = currentPage === totalPages;
  }

  /**
   * Go to next page
   */
  function changelogNextPage() {
    if (currentPage < totalPages) {
      currentPage++;
      renderChangelog();
    }
  }

  /**
   * Go to previous page
   */
  function changelogPrevPage() {
    if (currentPage > 1) {
      currentPage--;
      renderChangelog();
    }
  }

  // Expose pagination functions globally (called from HTML onclick)
  window.changelogNextPage = changelogNextPage;
  window.changelogPrevPage = changelogPrevPage;

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChangelog);
  } else {
    initChangelog();
  }

})();
