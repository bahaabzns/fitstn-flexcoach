require('dotenv').config();
const {createClient} = require('@supabase/supabase-js');
const fs = require('fs');
const { Pool } = require('pg');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const email = process.env.USER_EMAIL;
const password = process.env.USER_PASSWORD;

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// PostgreSQL connection pool
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
});

// Function to create tables if they don't exist
async function createTables() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS chat_rooms (
                id TEXT PRIMARY KEY,
                client_id TEXT,
                client_fullname TEXT,
                staff_id TEXT,
                unread_count INTEGER,
                last_message TEXT,
                last_message_at TIMESTAMP,
                data JSONB,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS chat_messages (
                id TEXT PRIMARY KEY,
                room_id TEXT REFERENCES chat_rooms(id),
                content TEXT,
                sender_id TEXT,
                sender_type TEXT,
                created_at TIMESTAMP,
                data JSONB,
                fetched_at TIMESTAMP DEFAULT NOW()
            );
        `);

        // Create indexes for faster queries
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_messages_room_id ON chat_messages(room_id);
            CREATE INDEX IF NOT EXISTS idx_messages_created_at ON chat_messages(created_at);
        `);

        console.log('Database tables ready');
    } finally {
        client.release();
    }
}

// Batch insert for chat rooms (faster than individual inserts)
async function batchInsertRooms(rooms) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        for (const room of rooms) {
            await client.query(
                `INSERT INTO chat_rooms (id, client_id, client_fullname, staff_id, unread_count, last_message, last_message_at, data)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (id) DO UPDATE SET
                    client_fullname = EXCLUDED.client_fullname,
                    unread_count = EXCLUDED.unread_count,
                    last_message = EXCLUDED.last_message,
                    last_message_at = EXCLUDED.last_message_at,
                    data = EXCLUDED.data`,
                [
                    room.id,
                    room.client?.id || null,
                    room.client?.fullname || null,
                    room.staff_id,
                    room.unread_count,
                    room.last_message?.content || null,
                    room.last_message?.sent_at || null,
                    JSON.stringify(room)
                ]
            );
        }
        
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// Batch insert for messages (much faster)
async function batchInsertMessages(messages, roomId) {
    if (messages.length === 0) return;
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        for (const msg of messages) {
            await client.query(
                `INSERT INTO chat_messages (id, room_id, content, sender_id, sender_type, created_at, data)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (id) DO UPDATE SET
                    content = EXCLUDED.content,
                    data = EXCLUDED.data`,
                [
                    msg.id,
                    roomId,
                    msg.content,
                    msg.sender_id,
                    msg.sender_type,
                    msg.created_at,
                    JSON.stringify(msg)
                ]
            );
        }
        
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// Fetch messages for a single room
async function fetchRoomMessages(roomId, roomIndex, totalRooms) {
    try {
        const { data: messages, error: messagesError } = await supabase.rpc('get_chat_messages', {
            p_before: new Date().toISOString(),
            p_limit: parseInt(process.env.NUMBER_OF_MESSAGES) || 50,
            p_room_id: roomId,
        });

        if (messagesError) {
            console.error(`  [${roomIndex}/${totalRooms}] Error for room ${roomId}:`, messagesError.message);
            return { roomId, messages: [], error: messagesError.message };
        }

        console.log(`  [${roomIndex}/${totalRooms}] Room ${roomId}: ${messages.length} messages`);
        
        // Save to database
        await batchInsertMessages(messages, roomId);
        
        return { roomId, messages, error: null };
    } catch (err) {
        console.error(`  [${roomIndex}/${totalRooms}] Exception for room ${roomId}:`, err.message);
        return { roomId, messages: [], error: err.message };
    }
}

// Process rooms in parallel batches
async function processBatch(roomIds, startIndex, batchSize, totalRooms) {
    const batch = roomIds.slice(startIndex, startIndex + batchSize);
    const promises = batch.map((roomId, i) => 
        fetchRoomMessages(roomId, startIndex + i + 1, totalRooms)
    );
    
    return await Promise.all(promises);
}

async function main() {
    console.log('Logging in with email and password...');

    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
        email: email,
        password: password,
    });

    if (authError) {
        console.error('Error during authentication:', authError);
        return;
    }

    console.log('Authentication successful!');
    console.log('User ID:', authData.user.id);

    // Create database tables
    await createTables();

    console.log('Fetching chat rooms...');
    const { data: chatRooms, error: chatRoomsError } = await supabase.rpc('get_chat_rooms_paginated', {
        p_assigned_staff_id: null,
        p_client_gender: null,
        p_coach_id: null,
        p_ghost_days: 3,
        p_ghost_only: false,
        p_last_interaction: null,
        p_last_interaction_from: null,
        p_last_interaction_to: null,
        p_last_message_from: null,
        p_limit: process.env.NUMBER_OF_ROOMS,
        p_no_assigned_staff: false,
        p_offset: 0,
        p_package_id: null,
        p_search: null,
        p_staff_id: "31fe5cc1-3e32-4096-b678-367e5a48e7d5",
        p_subscription_start_date: null,
        p_subscription_start_weekday: null,
        p_subscription_status: null,
        p_subscription_t_status: null,
        p_tenant_id: "fitstn",
        p_unread_only: false,
    });

    if (chatRoomsError) {
        console.error('Error fetching chat rooms:', chatRoomsError);
        return;
    }

    const roomIds = chatRooms.rooms.map(room => room.id);
    console.log(`Found ${roomIds.length} rooms out of ${chatRooms.total} total`);

    // Save chat rooms to database (batch operation)
    console.log('Saving chat rooms to database...');
    await batchInsertRooms(chatRooms.rooms);
    console.log(`✓ Saved ${chatRooms.rooms.length} chat rooms to database`);

    // Process messages in parallel batches for MUCH faster execution
    const BATCH_SIZE = parseInt(process.env.PARALLEL_BATCH_SIZE) || 10;
    console.log(`\nFetching messages for ${roomIds.length} rooms (${BATCH_SIZE} at a time)...\n`);
    
    const allResults = [];
    let totalMessagesSaved = 0;
    const startTime = Date.now();

    for (let i = 0; i < roomIds.length; i += BATCH_SIZE) {
        const batchResults = await processBatch(roomIds, i, BATCH_SIZE, roomIds.length);
        allResults.push(...batchResults);
        
        const messagesInBatch = batchResults.reduce((sum, r) => sum + r.messages.length, 0);
        totalMessagesSaved += messagesInBatch;
        
        const progress = Math.min(i + BATCH_SIZE, roomIds.length);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = (progress / (Date.now() - startTime) * 1000).toFixed(1);
        const eta = ((roomIds.length - progress) / rate).toFixed(0);
        
        console.log(`\n📊 Progress: ${progress}/${roomIds.length} rooms (${((progress/roomIds.length)*100).toFixed(1)}%) | ${elapsed}s elapsed | ETA: ${eta}s | Rate: ${rate} rooms/s\n`);
    }

    // Convert results to object format for JSON export
    const allMessages = {};
    allResults.forEach(result => {
        allMessages[result.roomId] = result.error ? { error: result.error } : result.messages;
    });

    // Save to JSON files as backup
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `chat_messages_${timestamp}.json`;
    fs.writeFileSync(filename, JSON.stringify(allMessages, null, 2));
    console.log(`\n✓ All messages saved to ${filename}`);

    fs.writeFileSync(`room_ids_${timestamp}.json`, JSON.stringify(roomIds, null, 2));
    console.log(`✓ Room IDs saved to room_ids_${timestamp}.json`);

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n🎉 Complete! Database Summary:`);
    console.log(`  - ${chatRooms.rooms.length} chat rooms saved`);
    console.log(`  - ${totalMessagesSaved} messages saved`);
    console.log(`  - Total time: ${totalTime}s`);
    console.log(`  - Average: ${(roomIds.length / totalTime).toFixed(1)} rooms/s`);

    await pool.end();
}


main();