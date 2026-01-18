// ============================================
// Shiiman Leads - Utility Functions
// ============================================

/**
 * Check if user is authenticated
 * Redirects to login if not authenticated
 */
async function checkAuth() {
  try {
    const response = await fetch('/api/me', { credentials: 'include' });
    if (response.ok) {
      const data = await response.json();
      // Store user info in localStorage for display
      localStorage.setItem('user', JSON.stringify(data.user));
      return true;
    } else {
      // Not authenticated, redirect to login (401 is expected behavior)
      if (response.status === 401) {
        // Silent redirect - this is normal when not logged in
        window.location.href = '/login.html';
      } else {
        console.warn('Auth check returned unexpected status:', response.status);
        window.location.href = '/login.html';
      }
      return false;
    }
  } catch (error) {
    // Only log if it's a real network error, not a 401
    console.error('Auth check network error:', error);
    window.location.href = '/login.html';
    return false;
  }
}

/**
 * Logout user and redirect to home
 */
async function logout() {
  if (confirm('Are you sure you want to logout?')) {
    try {
      await fetch('/logout', { method: 'POST', credentials: 'include' });
      localStorage.removeItem('user');
      window.location.href = '/';
    } catch (error) {
      console.error('Logout error:', error);
      localStorage.removeItem('user');
      window.location.href = '/';
    }
  }
}

/**
 * Format ISO date string to readable format
 * @param {string} isoString - ISO 8601 date string
 * @returns {string} Formatted date string
 */
function formatDate(isoString) {
  if (!isoString) return '-';
  try {
    const date = new Date(isoString);
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (error) {
    return isoString;
  }
}

/**
 * Escape HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Truncate text to specified length
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated text
 */
function truncate(text, maxLength = 100) {
  if (!text || text.length <= maxLength) return text || '';
  return text.substring(0, maxLength) + '...';
}

// Console welcome message
console.log('%c🚀 Shiiman Leads', 'font-size: 20px; font-weight: bold; color: #6366f1;');
console.log('%cClient Portal Ready', 'font-size: 12px; color: #666;');
