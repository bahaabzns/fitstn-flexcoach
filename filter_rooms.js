const fs = require('fs');

// Read the JSON file
const data = JSON.parse(fs.readFileSync('chat_rooms_2026-03-01T05-38-36-378Z.json', 'utf8'));

// Current date (March 1, 2026)
const currentDate = new Date('2026-03-01');

// Date 30 days ago
const thirtyDaysAgo = new Date(currentDate);
thirtyDaysAgo.setDate(currentDate.getDate() - 30);

console.log(`Current date: ${currentDate.toISOString()}`);
console.log(`30 days ago: ${thirtyDaysAgo.toISOString()}`);

// Filter rooms where last_client_message_at is within the last 30 days
const filteredRooms = data.rooms.filter(room => {
  if (!room.last_client_message_at) return false;
  const lastMessageDate = new Date(room.last_client_message_at);
  return lastMessageDate >= thirtyDaysAgo && lastMessageDate <= currentDate;
});

console.log(`\nTotal rooms: ${data.rooms.length}`);
console.log(`Rooms with messages in last 30 days: ${filteredRooms.length}`);

// Shuffle array randomly
function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// Randomly select 36 rooms
const shuffled = shuffleArray(filteredRooms);
const selected = shuffled.slice(0, 36);

// Extract client codes
const clientCodes = selected.map(room => room.client.code);

console.log(`\nRandomly selected 36 client codes:`);
console.log(clientCodes.join(', '));

// Save to file
fs.writeFileSync('selected_client_codes.json', JSON.stringify(clientCodes, null, 2));
console.log(`\nSaved to selected_client_codes.json`);
