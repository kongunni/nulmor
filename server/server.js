import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import moment from 'moment-timezone';
import Redis from 'ioredis';
import redisClient from '../utils/redis.js';
// es module 환경에서 디렉토리 경로 가져오기
import path, { normalize } from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const server = http.createServer(app);
const io = new Server(server);
// 데이터 저장소 redis 설정 port: 6379

// 채팅 로깅
import axios from 'axios'; 
import fs from 'fs-extra';
import { saveChatLog } from '../utils/chatLogger.js';

const LOGGER_SERVER_URL = 'http://localhost:4000/log'; // 로깅 서버 URL

// 정적 파일 경로 추가
app.use('/node_modules', express.static(path.join(__dirname, '../node_modules'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript');
        }
    }
}));

// 기존 라우터
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json()); // JSON 데이터 파싱을 위한 미들웨어


// Redis 연동 테스트
app.get('/test', async (req, res) => {
    try {
        // Redis에 데이터 저장
        await redisClient.set('testKey', 'testValue');
        const value = await redisClient.get('testKey');

        res.send({ success: true, value }); // Redis에서 가져온 값 반환
    } catch (err) {
        console.error('Redis error:', err);
        res.status(500).send({ success: false, error: err.message });
    }
});

/** 
 * 신고 처리 API
 * 클라이언트가 신고 데이터를 전송하면 이를 처리
 */
const MAX_REPORT = 100; // 최대 리포트 수
app.post('/chat/report', express.json(), async (req, res) => {
    const { roomId, partnerNickname, partnerIP, reasons } = req.body;

    if (!roomId || !partnerNickname || !partnerIP || !reasons) {
        return res.status(400).send({ success: false, message: '신고 데이터가 올바르지 않습니다.' });
    }

    console.log(`[server] 신고 접수 - 닉네임: ${partnerNickname}, IP: ${partnerIP}, 사유: ${reasons.join(', ')}`);

    const reasonMapping = {
        "스팸": "spam", 
        "비속어": "vulgarism", 
        "금전요구": "bankFraud",
        "기타": "etc"
    }

    const reasonsEng = reasons.map(reason => reasonMapping[reason] || "unknown");
   

    try {
        const reportKey = `banned:${partnerIP}`;
        const timestamp = moment().tz("Asia/Seoul").format("YY-MM-DD HH:mm:ss");

        // 기존 데이터 가져오기
        const currentData = await redisClient.hgetall(reportKey);
        const currentHistory = currentData.history ? JSON.parse(currentData.history) : [];
        const reportCount = (currentData.reportCount ? parseInt(currentData.reportCount) : 0) + 1;
        // const currentReportData = await redisClient.hgetall(reportKey);
        // let reportCount = currentReportData.reportCount ? parseInt(currentReportData.reportCount) : 0;
        // 새로운 신고 정보 추가
        const newReport = {
            nickname: partnerNickname || "Unknown",
            reason: reasonsEng.join(', '),
            timestamp: timestamp,
        };
        currentHistory.push(newReport);
     
        const keyType = await redisClient.type(reportKey); // 키 타입 확인
        if (keyType !== 'hash' && keyType !== 'none') {
            console.error(`[server] Redis 키 타입이 올바르지 않습니다: ${keyType}. 키를 초기화합니다.`);
            await redisClient.del(reportKey); // 잘못된 타입의 키 삭제
        }
        await redisClient.hset(reportKey, {
            reportCount: reportCount.toString(),
            userIP: partnerIP,
            history: JSON.stringify(currentHistory),
        });

        // MAX_REPORT 초과 여부 확인
        const isBanned = reportCount >= MAX_REPORT;
        if (isBanned) {
            console.log(`[server] MAX_REPORT 초과 유저(IP: ${partnerIP})는 더 이상 nulm을 이용할 수 없습니다. REPORT: ${reportCount}`);
        }

        // 현재 채팅방 가져오기
        const chatRoom = activeChats.get(roomId);
        if (chatRoom) {
            const [user1, user2] = chatRoom.users;
            const reporterSocket = user1.socket;
            const reportedSocket = user2.socket;

            await handleReport(roomId, reporterSocket, reportedSocket, reasons);
        }

        res.send({
            success: true,
            message: '신고가 접수되었습니다.',
            reportCount: reportCount,
            banned: isBanned,
        });
    } catch (error) {
        console.error(`[server] 신고 처리 중 오류 발생: ${error.message}`);
        res.status(500).send({ success: false, message: '신고 처리 중 오류가 발생했습니다.' });
    }
});

async function handleReport(roomId, reporterSocket, reportedSocket, reasons) {
    const reporterIP = reporterSocket.userIP; // 신고자
    const reportedIP = reportedSocket.userIP; // 신고 대상
    const reportedNickname = reportedSocket.nickname;
     // console.log(`[server] report ${reporterIP}-> ${reportedNickname}[${reportedIP}]`);

    try {
        const reportKey = `banned:${reportedIP}`;
        const currentReportData = await redisClient.hgetall(reportKey);
        let reportCount = currentReportData.reportCount ? parseInt(currentReportData.reportCount) : 0;

        // 신고 횟수 증가
        reportCount += 1;

        // 기존 신고 사유와 새로운 사유 병합
        const updatedReasons = currentReportData.reason
            ? `${currentReportData.reason}, ${reasons.join(', ')}`
            : reasons.join(', ');

        // Redis에 업데이트
        await redisClient.hset(reportKey, {
            reportCount: reportCount.toString(),
            userIP: reportedIP,
            nickname: reportedNickname,
            reason: updatedReasons,
            timestamp: new Date().toISOString(),
        });

        const isBanned = reportCount >= MAX_REPORT;
        if (isBanned) {
            //  console.log(`[server] 신고된 사용자 차단 처리 - IP: ${reportedIP}, 신고 수: ${reportCount}`);
            reportedSocket.disconnect();
        } else {
            reportedSocket.emit('chat-end', {
                message: '상대방이 채팅을 종료하였습니다.',
                messageType: 'system',
            });
        }

        reporterSocket.emit('chat-end', {
            message: '신고가 접수되어 연결이 종료되었습니다.',
            messageType: 'system',
        });

        // 대기열 처리 및 새로운 매칭 시도
        setTimeout(() => {
            reporterSocket.emit('wait-state', {
                message: '잠시만 기다려 주세요. \n 새로운 유저를 찾고 있습니다.',
                messageType: 'system',
            });

            if (!isBanned) {
                reportedSocket.emit('wait-state', {
                    message: '잠시만 기다려 주세요. \n 새로운 유저를 찾고 있습니다.',
                    messageType: 'system',
                });
            }
        }, 2000);

        setTimeout(() => {
            addToWaitingUsers(reporterSocket);

            if (!isBanned) {
                addToWaitingUsers(reportedSocket);
            }

            matchUsers();
        }, 5000);
    } catch (error) {
        console.error(`[server] 신고 처리 중 오류 발생: ${error.message}`);
    }
}
app.get('/admin/reports', async (req, res) => {
    try {
        const keys = await redisClient.keys('banned:*');
        const groupedReports = {};

        for (const key of keys) {
            const currentData = await redisClient.hgetall(key);
            const ip = currentData.userIP || key.split(':')[1];
            const history = currentData.history ? JSON.parse(currentData.history) : [];

            groupedReports[ip] = history.map((entry, index) => ({
                nickname: entry.nickname || 'Unknown', // 닉네임 기본값 설정
                reason: entry.reason || 'N/A',
                timestamp: entry.timestamp || 'N/A',
                count: index + 1,
            }));
        }

        const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Admin Reports</title>
            <style>
                table {
                    width: 100%;
                    border-collapse: collapse;
                }
                th, td {
                    border: 1px solid #ddd;
                    padding: 8px;
                    text-align: left;
                }
                th {
                    background-color: #f2f2f2;
                }
                .ip-cell {
                    vertical-align: middle;
                    text-align: center;
                }
            </style>
        </head>
        <body>
            <h1>Reported Users</h1>
            <table>
                <thead>
                    <tr>
                        <th>IP</th>
                        <th>Nickname</th>
                        <th>Reason</th>
                        <th>Timestamp</th>
                        <th>Count</th>
                    </tr>
                </thead>
                <tbody>
                    ${Object.entries(groupedReports)
                        .map(([ip, reports]) => {
                            return reports.map((report, index) => `
                                <tr>
                                    ${index === 0 ? `<td class="ip-cell" rowspan="${reports.length}">${ip}</td>` : ''}
                                    <td>${report.nickname}</td>
                                    <td>${report.reason}</td>
                                    <td>${report.timestamp}</td>
                                    <td>${report.count}</td>
                                </tr>
                            `).join('');
                        }).join('')}
                </tbody>
            </table>
        </body>
        </html>
        `;

        res.send(html);
    } catch (error) {
        console.error('[server] Admin report page error:', error.message);
        res.status(500).send('Internal Server Error');
    }
});


const PORT = process.env.PORT || 3000;
server.listen(3000, () => {
    console.log('Server is running on http://localhost:3000');
});

/*
 * start
*/ 

// 변수
const waitingUsers = new Map(); //대기열 관리
const activeChats = new Map(); //활성채팅

// 세션 타임아웃 설정
// const SESSION_DURATION = 1 * 60 * 1000; //test) 1분
const SESSION_DURATION = 8 * 60 * 60 * 1000; //8시간
const userSessions = new Map(); // 사용자 세션 상태 관리

// IPv4 반환
function normalizeIP(ip) {
    // "::1" (IPv6 localhost) 변환
    if (ip === "::1") {
        return "127.0.0.1";
    }

    // IPv6에서 IPv4 주소 추출
    if (ip.startsWith("::ffff:")) {
        return ip.replace("::ffff:", "");
    }

    // 이미 IPv4 형식이면 그대로 반환
    return ip;
}

io.on('connection', async (socket) => {
    //연결 초기상태 : 입장상태아님
    socket.entered=false;

    // // 유저
    // socket.userIP = normalizeIP(socket.handshake.address); // IPv4형식으로 반환
    // socket.nickname = `User_${Math.floor(Math.random() * 1000)}`;
    // console.log(`[server] 새로운 유저 연결: ${socket.id}, [${socket.nickname}[IP:${socket.userIP}]]`);

    //  // 클라이언트에 닉네임 전송
    //  socket.emit('set-nickname', socket.nickname);

    /* 차단된 계정 접근 불가 */
    // try {
    //     // 차단된 유저인지 확인
    //     const reportCount = await redisClient.get(`banned:${socket.userIP}`);

    //     if (reportCount && parseInt(reportCount) >= MAX_REPORT) {
    //         console.log(`[server] banned: IP:${socket.userIP}] - 리포트 수: ${reportCount}`);
    //         socket.emit('ban', { message: '서비스 이용 제한된 사용자입니다. 관리자에게 문의해 주세요.' });
    //         socket.disconnect();
    //         return;
    //     }
    // } catch (error) {
    //     console.error(`[server] Redis 오류: ${error.message}`);
    // }
    
    // 백그라운드 세션 유지 및 세션 설정
    if(!userSessions.has(socket.id)) {
        initializeSession(socket); //세션 초기화 한번만 호출 
    }    

    /* enter버튼 클릭시 입장대기열 추가 */
    socket.on('enter-state', async() => {

        if(!socket.entered) {
            socket.entered = true; // 버튼을 눌렀을때만 상태변경 
            // console.log('[server] client clicked enter-btn');

             // 유저
            socket.userIP = normalizeIP(socket.handshake.address); // IPv4형식으로 반환
            socket.nickname = `User_${Math.floor(Math.random() * 1000)}`;
            console.log(`[SERVER] NEW USER CONNECTED! : ${socket.nickname} [IP:${socket.userIP}]`);

            // 클라이언트에 닉네임 전송
            socket.emit('set-nickname', socket.nickname);

             /* 차단된 계정 접근 불가 */
            try {
                // 차단된 유저인지 확인
                const reportCount = await redisClient.get(`banned:${socket.userIP}`);

                if (reportCount && parseInt(reportCount) >= MAX_REPORT) {
                    console.log(`[server] banned: IP:${socket.userIP}] - 리포트 수: ${reportCount}`);
                    socket.emit('ban', { message: '서비스 이용 제한된 사용자입니다. 관리자에게 문의해 주세요.' });
                    socket.disconnect();
                    return;
                }
            } catch (error) {
                console.error(`[server] Redis 오류: ${error.message}`);
            }
            
            addToWaitingUsers(socket); //대기열 추가


            // 대기 상태 메시지 전송
            await delay(1000);
            socket.emit('wait-state', {
                message: "상대 유저를 찾는 중입니다. \n 잠시만 기다려 주세요.",
                messageType: 'system'
            });

            // 대기열 추가된 유저들과 랜덤 매칭
            matchUsers();

            //세션타이머리셋 : 사용자 활동시 리셋
            resetSessionTimeout(socket.id);
        } else {
            console.log(`[server] ${socket.nickname} ALREADY ENTERED`);
        }
    });

    // 메시지 전송 처리
    // socket.on('chat-message', (msg) => {
    socket.on('chat-message', async (msg) => {
        const chatRoom = getChatRoomByUser(socket.id); // 현재 소켓 ID로 방 정보 가져오기
        if (chatRoom) {
            chatRoom.room.users.forEach(user => {
                const messageType = user.id === socket.id ? 'sender' : 'receiver';
                user.socket.emit('chat-message', {
                    sender: socket.nickname,
                    message: msg,
                    messageType: messageType
                });
            });
            // console.log(`[server] Message from ${socket.nickname} in room ${chatRoom.roomId}: ${msg}`);
        
            /* 로그 */
            // 로그 데이터 생성
            const logData = {
                nickname: socket.nickname,
                userIP: socket.userIP,
                message: msg,     
                timestamp: new Date(),
            };
            //console.log(`[server] Log data:`, logData); // 디버깅용

            try {
                await saveChatLog(chatRoom.roomId, logData); // 채팅방 ID와 로그 데이터 저장
                // console.log(`[server] Log saved for room ${chatRoom.roomId}`);
            } catch (error) {
                console.error(`[server] Log failed to save for room ${chatRoom.roomId}: ${error.message}`);
            }
            // 세션 타이머 리셋
            resetSessionTimeout(socket.id); //메세지 전송시 세션 타이머 리셋
        } else {
            console.log(`[server] 메시지 처리 실패: ${socket.nickname}is not in a chat room.`);
        }
    });

    // 재연결 (restartBtn 클릭 이벤트 처리)
    socket.on('restart-connect', () => {
        // console.log(`[server] ${socket.userIP}님이 재연결을 요청하였습니다.`);
        const chatRoom = getChatRoomByUser(socket.id);
        if (chatRoom) {
            const { roomId , room } = chatRoom;
            
            const partner = room.users.find( user => user.id !== socket.id);
            if (partner) {
                if(partner.socket.connected) {
                    addToWaitingUsers(partner.socket);

                    // 상대방에게 연결종료 알림
                    partner.socket.emit('chat-end', {
                        message: '상대방이 연결을 종료하였습니다. \n 새로운 유저를 찾습니다.',
                        messageType: 'system'
                    });
                }
            }
            //방삭제
            removeChatRoom(roomId);
        }
       
         // 재연결 메시지 알림
         socket.emit('wait-state', {
            message: '연결을 종료하여 새로운 유저를 찾습니다.',
            messageType: 'system'
        });

        setTimeout(()=>{
             //본인을 대기열에 추가
            addToWaitingUsers(socket);
             // 재연결 메시지 알림
            socket.emit('wait-state', {
                message: '잠시만 기다려 주세요.',
                messageType: 'system'
            });
            // 새로운 매칭 시도
            matchUsers();
        }, 5000); //5초후 재연결 시도
    });

    // 신고 종료
    socket.on('report-disconnected', async ({ roomId }) => {
        const chatRoom = getChatRoomByUser(socket.id);
        if (!chatRoom) {
            socket.emit('system-message', { message: '신고 처리를 진행할 방이 없습니다.', messageType: 'error' });
            return;
        }

        const { room } = chatRoom;
        const partner = room.users.find((user) => user.id !== socket.id);

        if (!partner) {
            socket.emit('system-message', { message: '상대방 정보를 찾을 수 없습니다.', messageType: 'error' });
            return;
        }

        // 신고 처리
        handleReport(chatRoom.roomId, socket, partner.socket);
    });


    // 세션 처리 - 백그라운드와 서버 만료
    socket.on('session-action', (action) => {
        if (action === 'reset') {
            console.log(`[server] ${socket.nickname}[${socket.userIP}] session reset.`);
            resetSessionTimeout(socket.id);
        } else if (action === 'background') {
            console.log(`[server] ${socket.nickname}[${socket.userIP}]is now in the background.`);
            const session = userSessions.get(socket.id);
            if (session) {
                clearTimeout(session.timeout);
            }
            const timeout = setTimeout(() => {
                handleExpiredSession(socket); // 세션 만료시 처리
            }, SESSION_DURATION);
            userSessions.set(socket.id, { timeout });
        }
    });

    // 연결 종료 (시스템/네트워크 종료시) 
    socket.on('disconnect', ()=>{
        console.log(`[server] IP: ${socket.userIP} 서버 연결 종료.`);
        
        if (userSessions.has(socket.id)) {
            handleDisconnection(socket.id);
            clearSession(socket.id);
        } else {
            console.log(`[server] Session for ${socket.id} already cleared.`);
        }

    });

    // 연결 종료 (유저 요청)
    socket.on('user-disconnect', () => {
        console.log(`[server] IP: ${socket.userIP} 유저요청 연결 종료. `);
        // 연결 종료 처리
        handleDisconnection(socket.id);
    });



}); /* io.on connection */

/* function */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

//expired
function handleExpiredSession(socket) {
    // console.log(`[server] session expired for ${socket.id}`);
    const session = userSessions.get(socket.id);

    if (session) {
        console.log(`[server] Emitting session-expired for ${socket.id}`);
        userSessions.delete(socket.id);
        socket.emit('session-expired', {message: '세션만료되어 종료'});
        
        if(socket.entered) {
            removeFromWaitingQueue(socket.id); //대기열 제거
            console.log(`[server] Removing user ${socket.id} from waiting queue due to session expiration.`);
        }
        socket.disconnect(true);
    }
}



// 세션 초기화
function initializeSession(socket) {
    const expiryTime = Date.now() + SESSION_DURATION;

    const timeout = setTimeout(() => {
        handleExpiredSession(socket); // 만료 시 처리
    }, SESSION_DURATION);

    userSessions.set(socket.id, { expiryTime, timeout });
    console.log(`[server] SESSION initialized for ${socket.id}`);
}

// 세션 타이머 리셋
function resetSessionTimeout(socketId) {
    const session = userSessions.get(socketId);
    if (session) {
        clearTimeout(session.timeout);
    }

    const newExpiryTime = Date.now() + SESSION_DURATION;
    const timeout = setTimeout(() => {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
            handleExpiredSession(socket);
        }
    }, SESSION_DURATION);
 
    userSessions.set(socketId, { expiryTime: newExpiryTime, timeout });
    console.log(`[server] SESSION TIMEOUT RESET : ${socketId}`);
}

// 세션 종료 및 타이머 제거
function clearSession(socketId) {
    const session = userSessions.get(socketId);
    if (session) {
        clearTimeout(session.timeout);
        userSessions.delete(socketId);
        console.log(`[server] SESSION cleared for ${socketId}`);
    }
    removeFromWaitingQueue(socketId);  //대기열제거
}

// 대기열 관리
function addToWaitingUsers(socket){

    if (!socket.entered) {
        console.log(`[server] ${socket.id} attempted to join without entering. Ignoring.`);
        return false; // 사용자가 입장 버튼을 누르지 않았음
    }

    if (!waitingUsers.has(socket.id)) {
        waitingUsers.set(socket.id, { socket, nickname: socket.nickname, userIP: socket.userIP });
        console.log(`[server] [IP: ${socket.userIP}]님이 대기열에 추가되었습니다.`);
    } else {
        console.log(`[server] [IP: ${socket.userIP}]님은 이미 대기중입니다.`);
    }
    // console.trace(`[server-debug] addToWaitingUsers called for ${socket.id} [${socket.nickname}]`)
    return true;
};

// 대기열 삭제
function removeFromWaitingQueue(socketId) {
    if (waitingUsers.has(socketId)) {
        waitingUsers.delete(socketId);
        console.log(`[server] Removed ${socketId} from waiting queue.`);
    } else {
        console.log(`[server] ${socketId} not found in waiting queue.`);
    }
}

// 유저매칭 
function getNextUsersForMatch() {
    const users = Array.from(waitingUsers.values());
    console.log(`[server] Attempting to match users. Current queue:`, Array.from(waitingUsers.keys()));
    
    if (users.length >= 2) {
        const selectedUsers = users.slice(0, 2);
        selectedUsers.forEach(user => waitingUsers.delete(user.socket.id));
        // console.log(`[server] Matched users:`, selectedUsers.map(user => user.nickname));
        return selectedUsers;
    }
    console.log(`[server] Not enough users to match.`);
    return null;
}

// active chat
// 채팅 방 관리
function createChatRoom(user1, user2) {
    const roomId = `${user1.socket.id}#${user2.socket.id}`;

    // 활성 채팅 목록에 추가
    activeChats.set(roomId, {
        users: [
            { id: user1.socket.id, nickname: user1.socket.nickname, socket: user1.socket, partner: user2.socket.id },
            { id: user2.socket.id, nickname: user2.socket.nickname, socket: user2.socket, partner: user1.socket.id }
        ],
        roomId,
    });

    user1.socket.join(roomId);
    user2.socket.join(roomId);
    console.log(`[server] ${user1.nickname}님과 ${user2.nickname}님의 채팅방 생성: ${roomId}`);
    return roomId;
}


// getChatRoomByUSer
function getChatRoomByUser(socketId){
    for (const [roomId, room] of activeChats) {
        if (room.users.some(user => user.id === socketId)) {
            return { roomId, room };
        }
    }
    return null; // 해당 소켓 ID를 가진 유저가 없을 경우 null 반환
};

// 채팅방 비활성화
function removeChatRoom(roomId) {
    activeChats.delete(roomId);
}

// 유저 매칭
function matchUsers() {
    const users = getNextUsersForMatch();
    if (users) {
        const [user1, user2] = users;
        const roomId = createChatRoom(user1, user2);
        notifyChatReady(user1, user2, roomId);
        // console.log(`[server] Successfully matched users: ${user1.nickname} and ${user2.nickname} in room: ${roomId}`);
    } else {
        console.log(`[server] Not enough users to match.`);
    }
};

// 채팅 준비 알림
async function notifyChatReady(user1, user2, roomId) {
    const chatReadyPayload = (user, partner) => ({
        roomId,
        users: [
            { id: user.socket.id, nickname: user.socket.nickname, userIP:user.socket.userIP },
            { id: partner.socket.id, nickname: partner.socket.nickname, userIP:partner.socket.userIP }
        ],
        message: `${partner.nickname}님과 채팅을 시작합니다.`,
        messageType: 'system'
    });

    await delay(1000);
    user1.socket.emit('chat-ready', chatReadyPayload(user1, user2));
    user2.socket.emit('chat-ready', chatReadyPayload(user2, user1));

    // 방 전체에 경고 메시지 전송
    await delay(1500);
    io.to(roomId).emit('warning-message', {
        message: "금전 또는 개인정보를 요구받을 경우 신고해 주시기 바랍니다. 운영정책을 위반한 메시지로 신고 접수 시 이용에 제한이 있을 수 있습니다.",
        messageType: 'system'
    });
}

// partner - receiver sender 구분용
function getPartnerSocket(socketId) {
    for (const [roomId, room] of activeChats) {
        const user = room.users.find(user => user.id === socketId);
        if (user) {
            const partnerId = user.partner;
            // console.log(`[server] Partner socket ID for ${socketId} is ${partnerId}`);
            return io.sockets.sockets.get(partnerId); // 상대방의 소켓 객체 반환
        }
    }
    console.log(`[server] No partner found for socket ID: ${socketId}`);
    return null;
}


// 연결 종료
function handleDisconnection(socketId) {
    const chatRoom = getChatRoomByUser(socketId);

    if (chatRoom) {
        const { roomId, room } = chatRoom;

        // 상대방 찾기
        const partner = room.users.find(user => user.id !== socketId);

        if (partner && partner.socket.entered && partner.socket.connected) {
            // 대기열 중복 추가 방지
            if (!waitingUsers.has(partner.socket.id)) {
                const partnerSession = userSessions.get(partner.socket.id);
                if (partnerSession) {
                    console.log(`[server] ${partner.nickname}[${partner.userIP}]를 대기열에 다시 추가합니다.`);
                    addToWaitingUsers(partner.socket);

                    // 상대방에게 연결 종료 알림
                    partner.socket.emit('chat-end', {
                        message: '상대방이 연결을 종료하였습니다. \n 재연결을 위해 잠시만 기다려 주세요.',
                        messageType: 'system',
                    });
                }
            }
        }

        // 방 삭제
        removeChatRoom(roomId);
    }

    // 종료한 유저를 대기열에서 제거
    if (waitingUsers.has(socketId)) {
        removeFromWaitingQueue(socketId);
    }
    console.log(`[server] Disconnected user ${socketId} removed from queue.`);
}
