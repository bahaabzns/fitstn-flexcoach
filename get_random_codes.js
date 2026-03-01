require('dotenv').config();
const {createClient} = require('@supabase/supabase-js');
const fs = require('fs');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const email = process.env.USER_EMAIL;
const password = process.env.USER_PASSWORD;

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Function to read and parse the assignments CSV
function loadAssignments() {
    const csvContent = fs.readFileSync('assignments.csv', 'utf8');
    const lines = csvContent.split('\n');
    const assignments = {};
    
    // Skip header line
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        const [clientCode, agentName] = line.split(',');
        if (clientCode && agentName) {
            assignments[clientCode.trim()] = agentName.trim();
        }
    }
    
    return assignments;
}

async function getRandomClientCodes() {
    console.log('Loading agent assignments from CSV...');
    const assignments = loadAssignments();
    console.log(`Loaded ${Object.keys(assignments).length} client assignments`);
    
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

    console.log('\nFetching chat rooms from API in batches...');
    
    // Fetch rooms in batches to avoid timeout
    const BATCH_SIZE = 500;
    const NUM_BATCHES = 6; // 6 batches * 500 = 3000 rooms total
    let allRooms = [];
    
    for (let batch = 0; batch < NUM_BATCHES; batch++) {
        const offset = batch * BATCH_SIZE;
        console.log(`  Fetching batch ${batch + 1}/${NUM_BATCHES} (offset: ${offset})...`);
        
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
            p_limit: BATCH_SIZE,
            p_no_assigned_staff: false,
            p_offset: offset,
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
            console.error(`Error fetching batch ${batch + 1}:`, chatRoomsError);
            break;
        }
        
        allRooms.push(...chatRooms.rooms);
        console.log(`    Got ${chatRooms.rooms.length} rooms (total so far: ${allRooms.length})`);
        
        // If we got fewer rooms than requested, we've reached the end
        if (chatRooms.rooms.length < BATCH_SIZE) {
            console.log(`    Reached end of available rooms`);
            break;
        }
    }

    console.log(`\nFetched ${allRooms.length} rooms total`);
    
    const chatRooms = { rooms: allRooms };

    // Current date (March 1, 2026)
    const currentDate = new Date('2026-03-01');

    // Date 30 days ago
    const thirtyDaysAgo = new Date(currentDate);
    thirtyDaysAgo.setDate(currentDate.getDate() - 30);

    console.log(`\nCurrent date: ${currentDate.toISOString()}`);
    console.log(`30 days ago: ${thirtyDaysAgo.toISOString()}`);

    // Filter rooms where last_client_message_at is within the last 30 days
    const filteredRooms = chatRooms.rooms.filter(room => {
        if (!room.last_client_message_at) return false;
        const lastMessageDate = new Date(room.last_client_message_at);
        return lastMessageDate >= thirtyDaysAgo && lastMessageDate <= currentDate;
    });

    console.log(`\nTotal rooms fetched: ${chatRooms.rooms.length}`);
    console.log(`Rooms with client messages in last 30 days: ${filteredRooms.length}`);

    if (filteredRooms.length === 0) {
        console.log('\nNo rooms found with client messages in the last 30 days.');
        return;
    }

    // Target agents (excluding Awad)
    const targetAgents = ['Mohamed Tarek', 'Abdulla Ahmed', 'Manar'];
    const codesPerAgent = 12;

    // Group filtered rooms by agent
    const roomsByAgent = {
        'Mohamed Tarek': [],
        'Abdulla Ahmed': [],
        'Manar': []
    };

    for (const room of filteredRooms) {
        const clientCode = room.client.code.toString();
        const agentName = assignments[clientCode];
        
        if (agentName && roomsByAgent[agentName]) {
            roomsByAgent[agentName].push(room);
        }
    }

    console.log('\nRooms by agent (with messages in last 30 days):');
    for (const agent of targetAgents) {
        console.log(`  ${agent}: ${roomsByAgent[agent].length} rooms`);
    }

    // Shuffle array randomly
    function shuffleArray(array) {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    // Randomly select 12 rooms per agent
    const selectedByAgent = {};
    const allSelected = [];
    
    for (const agent of targetAgents) {
        const availableRooms = roomsByAgent[agent];
        const numToSelect = Math.min(codesPerAgent, availableRooms.length);
        const shuffled = shuffleArray(availableRooms);
        const selected = shuffled.slice(0, numToSelect);
        
        selectedByAgent[agent] = selected;
        allSelected.push(...selected);
        
        console.log(`  Selected ${numToSelect} codes for ${agent}`);
    }

    // Extract all client codes
    const allClientCodes = allSelected.map(room => room.client.code);

    console.log(`\nTotal selected: ${allClientCodes.length} client codes`);
    console.log('\nClient codes by agent:');
    
    for (const agent of targetAgents) {
        const codes = selectedByAgent[agent].map(room => room.client.code);
        console.log(`\n${agent} (${codes.length} codes):`);
        console.log(codes.join(', '));
    }

    console.log(`\nAll codes combined:`);
    console.log(allClientCodes.join(', '));

    // Fetch messages for selected rooms
    console.log('\n\nFetching chat messages for selected rooms...');
    const roomsWithMessages = [];
    let processedCount = 0;
    
    for (const room of allSelected) {
        processedCount++;
        console.log(`  [${processedCount}/${allSelected.length}] Fetching messages for room ${room.id} (${room.client.fullname})...`);
        
        try {
            const { data: messages, error: messagesError } = await supabase.rpc('get_chat_messages', {
                p_before: new Date().toISOString(),
                p_limit: 100, // Get up to 100 messages
                p_room_id: room.id,
            });

            if (messagesError) {
                console.error(`    Error: ${messagesError.message}`);
                roomsWithMessages.push({
                    ...room,
                    messages: [],
                    messages_error: messagesError.message
                });
            } else {
                console.log(`    Got ${messages.length} messages`);
                roomsWithMessages.push({
                    ...room,
                    messages: messages
                });
            }
        } catch (err) {
            console.error(`    Exception: ${err.message}`);
            roomsWithMessages.push({
                ...room,
                messages: [],
                messages_error: err.message
            });
        }
    }

    console.log(`\n✓ Fetched messages for all ${processedCount} rooms`);

    // Save to file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `selected_client_codes_${timestamp}.json`;
    
    // Create a map to quickly find rooms with messages
    const roomsWithMessagesMap = {};
    for (const room of roomsWithMessages) {
        roomsWithMessagesMap[room.id] = room;
    }
    
    const output = {
        timestamp: new Date().toISOString(),
        filter_criteria: {
            date_range: {
                from: thirtyDaysAgo.toISOString(),
                to: currentDate.toISOString()
            },
            agents: targetAgents,
            codes_per_agent: codesPerAgent,
            total_requested: targetAgents.length * codesPerAgent
        },
        total_rooms_fetched: chatRooms.rooms.length,
        total_matching_rooms: filteredRooms.length,
        all_client_codes: allClientCodes,
        summary: {
            total_clients: allSelected.length,
            total_messages_fetched: roomsWithMessages.reduce((sum, r) => sum + (r.messages?.length || 0), 0)
        },
        by_agent: {}
    };

    // Add full details for each agent
    for (const agent of targetAgents) {
        const agentRooms = selectedByAgent[agent];
        const codes = agentRooms.map(room => room.client.code);
        
        output.by_agent[agent] = {
            codes: codes,
            count: codes.length,
            clients: agentRooms.map(room => {
                const roomWithMessages = roomsWithMessagesMap[room.id];
                return {
                    client: room.client,
                    room: {
                        id: room.id,
                        name: room.name,
                        is_group: room.is_group,
                        created_at: room.created_at,
                        updated_at: room.updated_at,
                        last_message_id: room.last_message_id,
                        last_client_message_at: room.last_client_message_at,
                        unread_count: room.unread_count,
                        is_marked_unread: room.is_marked_unread
                    },
                    subscription: room.subscription,
                    assigned_staff: room.assigned_staff,
                    messages: roomWithMessages?.messages || [],
                    messages_count: roomWithMessages?.messages?.length || 0,
                    messages_error: roomWithMessages?.messages_error
                };
            })
        };
    }

    fs.writeFileSync(filename, JSON.stringify(output, null, 2));
    console.log(`\n✓ Saved complete data to ${filename}`);

    // Also save just the codes for easy copy-paste
    const codesFilename = `client_codes_only_${timestamp}.txt`;
    let codesText = `Selected Clients with Chat Data - ${new Date().toISOString()}\n`;
    codesText += `Date Range: ${thirtyDaysAgo.toISOString()} to ${currentDate.toISOString()}\n`;
    codesText += `Total Messages Fetched: ${output.summary.total_messages_fetched}\n`;
    codesText += `${'='.repeat(80)}\n\n`;
    
    codesText += `All codes (${allClientCodes.length}):\n${allClientCodes.join(', ')}\n\n`;
    codesText += `${'='.repeat(80)}\n\n`;
    
    for (const agent of targetAgents) {
        const agentData = output.by_agent[agent];
        const totalMessages = agentData.clients.reduce((sum, c) => sum + c.messages_count, 0);
        
        codesText += `${agent} (${agentData.codes.length} clients, ${totalMessages} messages):\n`;
        codesText += `Codes: ${agentData.codes.join(', ')}\n\n`;
        
        // List each client with message count
        agentData.clients.forEach((client, idx) => {
            codesText += `  ${idx + 1}. ${client.client.fullname} (Code: ${client.client.code})\n`;
            codesText += `     Messages: ${client.messages_count}\n`;
            codesText += `     Last message: ${client.room.last_client_message_at}\n`;
            if (client.messages_error) {
                codesText += `     Error: ${client.messages_error}\n`;
            }
            codesText += `\n`;
        });
        
        codesText += `${'-'.repeat(80)}\n\n`;
    }
    
    fs.writeFileSync(codesFilename, codesText);
    console.log(`✓ Summary saved to ${codesFilename}`);
    
    console.log('\n' + '='.repeat(80));
    console.log('FINAL SUMMARY');
    console.log('='.repeat(80));
    console.log(`Total clients selected: ${allSelected.length}`);
    console.log(`Total messages fetched: ${output.summary.total_messages_fetched}`);
    console.log('\nBreakdown by agent:');
    for (const agent of targetAgents) {
        const agentData = output.by_agent[agent];
        const totalMessages = agentData.clients.reduce((sum, c) => sum + c.messages_count, 0);
        console.log(`  ${agent}: ${agentData.count} clients, ${totalMessages} messages`);
    }
    console.log('='.repeat(80));
}

getRandomClientCodes().catch(console.error);
