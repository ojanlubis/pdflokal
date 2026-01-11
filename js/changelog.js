/**
 * PDFLokal Changelog Notification System
 * Manages changelog display with badge and expanded views
 */

(function() {
  'use strict';

  // Changelog data - Add new updates at the beginning of the array
  const changelogData = [
    {
      title: "Font bisa diakses di jaringan terbatas",
      description: "Update penggunaan font agar bisa diakses di restricted network (self hosting font)",
      date: "11 Januari 2026"
    },
    {
      title: "Perbaikan Editor PDF",
      description: "Memperbaiki bug pada fitur tanda tangan digital dan whiteout",
      date: "8 Januari 2026"
    },
    {
      title: "Peningkatan Performa",
      description: "Optimasi kecepatan pemrosesan PDF dan gambar hingga 2x lebih cepat",
      date: "5 Januari 2026"
    },
    {
      title: "Fitur Baru: Watermark",
      description: "Tambahkan watermark teks atau gambar ke dokumen PDF Anda",
      date: "3 Januari 2026"
    },
    {
      title: "UI/UX Improvements",
      description: "Tampilan baru yang lebih modern dan responsif untuk mobile",
      date: "1 Januari 2026"
    },
    {
      title: "Kompres Gambar",
      description: "Fitur kompres gambar dengan preview real-time kini tersedia",
      date: "28 Desember 2025"
    },
    {
      title: "Dark Mode Support",
      description: "Dukungan dark mode otomatis mengikuti preferensi sistem",
      date: "25 Desember 2025"
    },
    {
      title: "Peluncuran Awal",
      description: "PDFLokal diluncurkan dengan fitur merge, split, dan edit PDF",
      date: "20 Desember 2025"
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
      // Returning visitor + NEW content available → Show expanded
      showExpanded();
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

    // If user has NEW content (or first visit), show expanded
    if (lastClosedTitle && lastClosedTitle !== latestChangelogTitle) {
      showExpanded();
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
