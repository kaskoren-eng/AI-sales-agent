// Run with: node scripts/configure-monday.js
// Fill in your values below before running

const MONDAY_API_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjQ0OTQ0MTIwMSwiYWFpIjoxMSwidWlkIjo2MTQ0MzgwOCwiaWFkIjoiMjAyNC0xMi0xOFQwNjoyODo1OC4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6ODQwODcyNiwicmduIjoidXNlMSJ9.KMQ_OaUtku09B5uGVO9LBkQ7PPcN-VlLT999GUZyLMo';
const MONDAY_BOARD_ID = '8854910976';

// -----------------------------------------------
// Nothing to change below this line
// -----------------------------------------------

const API_KEY = 'sk_30a995d484db4a850e61900126df5f5a7301c1a5ea1ef021c02b07127c169eb7';

if (MONDAY_API_TOKEN === 'PASTE_YOUR_MONDAY_TOKEN_HERE' || MONDAY_BOARD_ID === 'PASTE_YOUR_BOARD_ID_HERE') {
  console.error('❌  Please fill in MONDAY_API_TOKEN and MONDAY_BOARD_ID at the top of this file first.');
  process.exit(1);
}

const res = await fetch('http://localhost:3000/api/v1/integrations/monday/configure', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_KEY}`,
  },
  body: JSON.stringify({
    apiToken: MONDAY_API_TOKEN,
    boardId: MONDAY_BOARD_ID,
    columnMap: {},
  }),
});

const data = await res.json();

if (res.ok) {
  console.log('✅  Monday.com connected successfully!');
  console.log('   Board ID:', data.boardId);
} else {
  console.error('❌  Error:', data.error ?? JSON.stringify(data));
}
