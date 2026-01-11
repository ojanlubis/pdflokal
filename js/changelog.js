/**
 * PDFLokal Changelog Notification System
 * Manages changelog display with badge and expanded views
 */

(function() {
  'use strict';

  // Changelog data - Add new updates at the beginning of the array
  const changelogData = [
    {
      title: "File PDF Kamu Jadi Lebih Kecil",
      description: "PDF dengan tanda tangan sekarang 80% lebih kecil! Download lebih cepat, hemat ruang penyimpanan. File yang tidak diedit tetap ukuran aslinya.",
      date: "12 Januari 2026"
    },
    {
      title: "Tanda Tangan Lebih Mudah Diatur",
      description: "Tanda tangan otomatis terkunci setelah ditempatkan (anti geser tidak sengaja). Klik 2x untuk unlock. Bisa dihapus jika salah. Terima kasih @hamdi1611! 🙏",
      date: "11 Januari 2026"
    },
    {
      title: "Notifikasi Update di Pojok Layar",
      description: "Sekarang kamu bisa lihat update terbaru lewat badge merah di pojok kanan. Kami terus bekerja untuk aplikasi yang kamu pakai gratis ini! 💪",
      date: "11 Januari 2026"
    },
    {
      title: "Tetap Berfungsi di Jaringan Terbatas",
      description: "PDFLokal sekarang bisa diakses di kantor/sekolah yang blokir internet eksternal. Semua font sudah tersedia offline. Privasi kamu lebih terjaga.",
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
      description: "Sekarang kamu bisa resize kotak teks (tarik pojok), edit langsung (klik 2x), dan tekan Enter untuk langsung submit. Lebih cepat!",
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
