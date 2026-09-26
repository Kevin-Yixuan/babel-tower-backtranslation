(() => {
  function key(url) {
    try {
      const u = new URL(url, location.origin);
      if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(u.hostname)) return '';
      const post = u.pathname.match(/\/status\/(\d+)/);
      if (post) return 'post:' + post[1];
      const article = u.pathname.match(/\/(?:i\/)?article\/(\d+)/);
      if (article) return 'article:' + article[1];
      if (/^\/compose\/(?:post|tweet)\/?$/.test(u.pathname)) return 'compose';
    } catch { /* unknown route */ }
    return '';
  }
  function canonical(url) {
    const id = key(url);
    if (id.startsWith('post:')) return 'https://x.com/i/status/' + id.slice(5);
    if (id.startsWith('article:')) return 'https://x.com/i/article/' + id.slice(8);
    if (id === 'compose') return 'https://x.com/compose/post';
    return url || '';
  }
  function postUrl(article) {
    const links = [...article.querySelectorAll('a[href*="/status/"]')]
      .filter(a => a.closest('article') === article && !a.closest('[data-testid="quoteTweet"]'));
    const link = links.find(a => a.querySelector('time')) || links.find(a => !a.closest('[data-testid="tweetText"]'));
    return canonical(link?.href || '');
  }
  window.BXContext = { key, canonical, postUrl };
})();
