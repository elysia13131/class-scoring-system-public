import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import ReactECharts from 'echarts-for-react';
import * as XLSX from 'xlsx-js-style';
import { User, BarChart3, Star, Clock, LayoutDashboard, ChevronRight, X, Play, AlertTriangle, HeartPulse, TrendingDown, TrendingUp, CheckCircle2, Settings, ChevronLeft, Download, Brain, MessageSquare } from 'lucide-react';
import { getApiUrl, setApiUrl, getFullApiUrl, getSocketUrl } from './apiConfig';
import DailyCheckinModal from './components/DailyCheckinModal';
import DailyQuestion from './components/DailyQuestion';
import WeeklyNote from './components/WeeklyNote';
import AdminCheckin from './components/AdminCheckin';
import DailyReportModal from './components/DailyReportModal';
import ScheduleCalendar from './components/ScheduleCalendar';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Capacitor push (only in native environment)
let isCapacitorNative = false;
try {
  if (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.isNativePlatform()) {
    isCapacitorNative = true;
  }
} catch (e) {
  // Not in Capacitor environment
}
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Browser } from '@capacitor/browser';
import { FileOpener } from '@capacitor-community/file-opener';
import ChatContainer from './components/agent/ChatContainer';
import ParticleBackground from './components/agent/ParticleBackground';
import WeChatPasswordVerify from './components/WeChatPasswordVerify';
import AdminPasswordInput from './components/AdminPasswordInput';
import QrTimer from './components/QrTimer';

// 姓名处理函数：显示首尾两个字，中间用*代替
const maskName = (name) => {
  if (!name || name.length <= 1) return name;
  if (name.length === 2) return name[0] + '*';
  return name[0] + '*'.repeat(name.length - 2) + name[name.length - 1];
};

// 班级名称处理函数：只显示班长的姓，名用*代替
const maskClassName = (className) => {
  if (!className) return className;
  // 班级名称格式通常是"姓名班"
  const match = className.match(/^(.+)班$/);
  if (match) {
    const name = match[1];
    return maskName(name) + '班';
  }
  return className;
};

// URL 主机名提取（播放清单缺省 label 用）
const hostOf = (u) => {
  try { return new URL(u).host; } catch { return String(u || '').slice(0, 60); }
};

// MBTI详细介绍数据
const MBTI_DATA = {
  'INTJ': {
    name: '建筑师',
    description: '富有想象力和战略性思维的计划者，一切都在计划之中',
    traits: ['独立思考', '战略性', '有远见', '创新', '追求卓越'],
    strengths: ['战略思维', '创新能力', '坚定决心', '高标准', '独立自主'],
    weaknesses: ['过于理性', '社交障碍', '过度完美主义', '不耐烦', '固执']
  },
  'INTP': {
    name: '逻辑学家',
    description: '具有创造力的发明家，对知识有着永不满足的渴望',
    traits: ['逻辑思维', '好奇', '创新', '灵活', '理性'],
    strengths: ['分析能力', '创新思维', '客观公正', '适应力强', '诚实直接'],
    weaknesses: ['社交困难', '拖延症', '过于理论化', '缺乏条理', '忽视细节']
  },
  'ENTJ': {
    name: '指挥官',
    description: '大胆、富有想象力且意志坚强的领导者，总能找到或创造解决办法',
    traits: ['领导能力', '果断', '自信', '效率', '战略'],
    strengths: ['领导才能', '果断决策', '高效执行', '战略眼光', '自信坚定'],
    weaknesses: ['固执霸道', '缺乏耐心', '不敏感', '过于强势', '控制欲强']
  },
  'ENTP': {
    name: '辩论家',
    description: '聪明好奇的思想者，不会放弃任何智力上的挑战',
    traits: ['机智', '创新', '灵活', '好奇', '善于辩论'],
    strengths: ['快速反应', '创新能力', '多才多艺', '富有魅力', '知识渊博'],
    weaknesses: ['不切实际', '缺乏专注', '好争论', '难以完成', '不够敏感']
  },
  'INFJ': {
    name: '提倡者',
    description: '安静而神秘，同时鼓舞人心且不知疲倦的理想主义者',
    traits: ['理想主义', '富有同情心', '创造力', '洞察力', '坚定'],
    strengths: ['创造力', '洞察力', '富有同情心', '坚定信念', '追求意义'],
    weaknesses: ['过于敏感', '完美主义', '回避冲突', '容易疲惫', '过于理想化']
  },
  'INFP': {
    name: '调停者',
    description: '诗意、善良的利他主义者，总是热情地为正当理由提供帮助',
    traits: ['理想主义', '富有创造力', '敏感', '同理心', '寻求和谐'],
    strengths: ['创造力', '富有同情心', '理想主义', '适应力强', '真诚'],
    weaknesses: ['过于敏感', '不切实际', '自我封闭', '缺乏条理', '容易受伤']
  },
  'ENFJ': {
    name: '主人公',
    description: '富有魅力且鼓舞人心的领导者，能迷住他们的听众',
    traits: ['热情', '有同情心', '社交能力', '领导力', '理想主义'],
    strengths: ['社交能力', '领导魅力', '富有同情心', '责任感', '激励他人'],
    weaknesses: ['过度负责', '过于理想化', '容易受伤', '过于迁就', '自我牺牲']
  },
  'ENFP': {
    name: '竞选者',
    description: '热情、有创造力、社交自由的人，总能找到微笑的理由',
    traits: ['热情', '富有创造力', '好奇', '灵活', '善于沟通'],
    strengths: ['热情洋溢', '创新能力', '沟通能力', '适应力强', '富有魅力'],
    weaknesses: ['缺乏专注', '过于理想化', '容易分心', '不够实际', '过度承诺']
  },
  'ISTJ': {
    name: '物流师',
    description: '实际且注重事实的人，他们的可靠性不容置疑',
    traits: ['务实', '有条理', '可靠', '传统', '责任感'],
    strengths: ['可靠性', '责任感', '有条理', '注重细节', '忠诚'],
    weaknesses: ['过于固执', '不够灵活', '缺乏创新', '过于严肃', '难以适应']
  },
  'ISFJ': {
    name: '守卫者',
    description: '非常专注且温暖的保护者，时刻准备着保护所爱之人',
    traits: ['关怀', '可靠', '耐心', '传统', '谦逊'],
    strengths: ['关怀他人', '可靠负责', '耐心细致', '忠诚', '组织能力'],
    weaknesses: ['过于谦虚', '回避冲突', '过度奉献', '不够灵活', '容易内疚']
  },
  'ESTJ': {
    name: '总经理',
    description: '出色的管理者，在管理事情或人的方面无与伦比',
    traits: ['务实', '有条理', '直接', '传统', '组织能力'],
    strengths: ['组织能力', '务实精神', '直接坦诚', '责任感', '领导力'],
    weaknesses: ['固执己见', '不够灵活', '缺乏创新', '过于强势', '不敏感']
  },
  'ESFJ': {
    name: '执政官',
    description: '极有同情心、爱社交的人，总是热心帮助别人',
    traits: ['社交能力', '关怀', '传统', '合作', '责任感'],
    strengths: ['社交能力', '关怀他人', '组织能力', '合作精神', '忠诚'],
    weaknesses: ['过于依赖他人', '回避冲突', '不够创新', '过于传统', '容易受伤']
  },
  'ISTP': {
    name: '鉴赏家',
    description: '大胆而实际的实验家，擅长使用任何形式的工具',
    traits: ['务实', '灵活', '冷静', '独立', '动手能力'],
    strengths: ['务实精神', '灵活适应', '冷静理性', '独立解决', '动手能力'],
    weaknesses: ['缺乏规划', '不够敏感', '容易无聊', '难以承诺', '过于随性']
  },
  'ISFP': {
    name: '探险家',
    description: '灵活且有魅力的艺术家，时刻准备探索和体验新事物',
    traits: ['艺术感', '敏感', '灵活', '温和', '追求和谐'],
    strengths: ['艺术才能', '灵活适应', '富有同情心', '温和友善', '创造力'],
    weaknesses: ['过于敏感', '缺乏自信', '逃避冲突', '难以规划', '容易受伤']
  },
  'ESTP': {
    name: '企业家',
    description: '聪明、精力充沛、善于感知的人，真正享受生活在边缘',
    traits: ['灵活', '务实', '精力充沛', '直接', '善于行动'],
    strengths: ['务实精神', '快速反应', '适应力强', '行动导向', '解决问题'],
    weaknesses: ['缺乏耐心', '不够深入', '容易冲动', '忽视长期', '过于冒险']
  },
  'ESFP': {
    name: '表演者',
    description: '自发、精力充沛而热情的表演者，生活在他们身边永不无聊',
    traits: ['热情', '社交能力', '灵活', '乐观', '活在当下'],
    strengths: ['社交能力', '热情洋溢', '灵活适应', '乐观向上', '富有魅力'],
    weaknesses: ['缺乏规划', '容易分心', '不够深入', '难以专注', '逃避严肃']
  }
};

// 配置PDF.js worker - 使用unpkg CDN
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@5.5.207/build/pdf.worker.min.mjs`;

// Connect to the backend using configured URL
let socket = null;

const dimensions = [
  { 
    key: 'study', 
    label: '学习成绩',
    subItems: [
      { key: 'prep', label: '预习准备', minScore: 0, maxScore: 2, 
        criteria: '1-2分：提前预习课程重点，标记疑难问题，针对课程提前做好相关知识准备；0分：未进行预习，上课前对课程内容完全不了解' },
      { key: 'class', label: '课堂参与', minScore: 0, maxScore: 2,
        criteria: '1-2分：认真听讲，主动回答问题，参与课堂互动讨论，擅用康奈尔笔记法精准记录课堂要点笔记；0分：上课注意力不集中，频繁走神打瞌睡，消极慵懒，不参与课堂互动' },
      { key: 'review', label: '复习巩固', minScore: 0, maxScore: 2,
        criteria: '1-2分：课后24小时内完成复习，整理知识点框架，能够结合案例深化医学知识理解；0分：不进行复习，对课堂所学内容很快遗忘' },
      { key: 'apply', label: '知识应用', minScore: 0, maxScore: 2,
        criteria: '1-2分：能够将所学知识在"三互"小组内"输出"即说出来、做出来，将理论知识与实践结合，正确运用所学知识；0分：仅死记硬背，无法灵活运用知识解决实际问题' },
      { key: 'result', label: '学业成果', minScore: 0, maxScore: 2,
        criteria: '1-2分：作业按时高质量完成并提交，小测验成绩优良，主动请教疑难问题；0分：作业拖延或抄袭，测验成绩不及格，不主动弥补知识漏洞' }
    ]
  },
  { 
    key: 'fitness', 
    label: '体能素质',
    subItems: [
      { key: 'base', label: '基础体能成绩', minScore: 0, maxScore: 3,
        criteria: '2-3分：三公里跑、单杠引体向上/曲臂悬垂达到优良标准，成绩稳定提升；1分：基本达到合格标准，但成绩波动较大；0分：一项或多项体能科目不及格' },
      { key: 'attitude', label: '训练态度方法', minScore: 0, maxScore: 2,
        criteria: '1-2分：主动参与体能训练，积极向特长学员请教，能够掌握科学训练方法，不盲目蛮练；0分：训练消极敷衍，经常请假缺席，不按要求完成训练任务' },
      { key: 'health', label: '健康管理', minScore: 0, maxScore: 2,
        criteria: '1-2分：合理搭配饮食，控制体脂率在标准范围内，作息规律不熬夜；0分：饮食不规律，体脂率超标，经常熬夜影响训练状态' },
      { key: 'injury', label: '伤病管理', minScore: 0, maxScore: 2,
        criteria: '1-2分：无伤病，身体状态良好，训练前后能够积极拉伸；有伤病时及时就医，按医嘱进行康复训练，不擅自中断治疗；0分：伤病后不重视治疗，康复训练不积极，影响整体训练进度' },
      { key: 'improve', label: '体能提升', minScore: 0, maxScore: 1,
        criteria: '1分：制定个人体能提升计划，每周有明确进步目标并落地实现；0分：无提升计划，体能水平停滞不前或下降' }
    ]
  },
  { 
    key: 'literacy', 
    label: '人文素养',
    subItems: [
      { key: 'reading', label: '阅读学习', minScore: 0, maxScore: 2,
        criteria: '1-2分：每周阅读军事理论、医学人文或经典著作不少于2小时，能主动分享阅读心得；0分：不进行课外阅读，仅完成课程要求的阅读任务' },
      { key: 'culture', label: '文体活动', minScore: 0, maxScore: 2,
        criteria: '1-2分：主动参与中队及以上文体活动（歌咏比赛、演讲比赛、体育竞赛等），表现积极投入；0分：不参与文体活动，或参与时消极应付' },
      { key: 'discipline', label: '自律意识', minScore: 0, maxScore: 2,
        criteria: '1-2分：有效克服惰性和拖延症，按时完成各项学习训练任务，无迟到早退现象；0分：经常拖延任务，需要他人反复催促，存在迟到早退行为' },
      { key: 'problem', label: '问题解决', minScore: 0, maxScore: 2,
        criteria: '1-2分：遇到学习、生活、训练问题能冷静分析，主动寻找解决办法，不依赖他人；0分：遇到问题逃避退缩，等待他人解决，缺乏独立思考能力' },
      { key: 'empathy', label: '共情能力', minScore: 0, maxScore: 2,
        criteria: '1-2分：能主动关心同学思想和生活状况，从"三互"小组开始，在同学遇到困难（学习落后、体能不佳、生活困扰等）时主动提供帮助；0分：对同学困难漠不关心，缺乏团队互助意识' }
    ]
  },
  { 
    key: 'discipline', 
    label: '遵章守纪',
    subItems: [
      { key: 'queue', label: '队列内务', minScore: 0, maxScore: 2,
        criteria: '1-2分：队列动作标准规范，内务整理符合标准（被子质量高、物品摆放整齐），无任何违规记录；0分：队列动作不标准，内务经常不合格，被队干部及上级通报批评' },
      { key: 'duty', label: '值班岗哨', minScore: 0, maxScore: 2,
        criteria: '1-2分：按时到岗履职，认真完成值班岗哨工作，详细记录值班情况，无擅离职守行为；0分：值班岗哨迟到早退，履职不认真，存在擅离职守现象' },
      { key: 'daily', label: '日常规范', minScore: 0, maxScore: 3,
        criteria: '2-3分：严格遵守用网规定（不浏览违规网站、不随意传播网络信息）、消费规定（不铺张浪费、不攀比）、异性交往规定（保持健康文明交往）；1分：存在轻微违规行为，经队干部或骨干提醒后及时改正；0分：存在严重违规行为，被给予纪律处分' },
      { key: 'class', label: '课堂纪律', minScore: 0, maxScore: 2,
        criteria: '1-2分：上课、自习时精神饱满，不瞌睡、不玩手机，自觉维护课堂/自习秩序；0分：上课自习时经常瞌睡、玩手机，影响自身学习及他人学习状态' },
      { key: 'safety', label: '安全意识', minScore: 0, maxScore: 1,
        criteria: '1分：严格遵守实验室、训练场、教室、宿舍等场所的安全规定，无任何安全隐患行为；0分：安全意识淡薄，存在违反安全规定的行为（如实验室违规操作、训练场违规训练等）' }
    ]
  },
  { 
    key: 'contribution', 
    label: '班级贡献',
    subItems: [
      { key: 'work', label: '本职工作', minScore: 0, maxScore: 2,
        criteria: '1-2分：高质量完成分内公差勤务（教室打扫、物资搬运、器材整理等），不推诿、不敷衍；0分：不认真完成本职工作，经常推诿责任、敷衍了事' },
      { key: 'environment', label: '环境维护', minScore: 0, maxScore: 2,
        criteria: '1-2分：主动维护宿舍及班级公共区域卫生（及时倒垃圾、整理公共物品、擦拭公共设施等），带动同学共同维护集体环境；0分：不主动维护环境，甚至乱扔垃圾、破坏公共卫生' },
      { key: 'collective', label: '集体建设', minScore: 0, maxScore: 2,
        criteria: '1-2分：为班级和三互小组进步提出切实可行的建议（如学习方法分享、体能训练计划、集体活动方案等），并积极参与落地落实；0分：不关心集体建设，不提出任何建议，对集体事务漠不关心' },
      { key: 'honor', label: '荣誉争取', minScore: 0, maxScore: 2,
        criteria: '1-2分：积极参与各类竞赛、评比活动（学科竞赛、体能比武、队列评比等），努力为班级争得荣誉；0分：不参与集体荣誉争取，甚至因个人不当行为影响班级荣誉' },
      { key: 'help', label: '互助支持', minScore: 0, maxScore: 2,
        criteria: '1-2分：主动帮助学习困难、体能落后的同学，分享学习/训练方法，形成班级互助共进的良好氛围；0分：不帮助他人，甚至存在孤立同学、排斥同学的行为' }
    ]
  },
  { 
    key: 'management', 
    label: '管理能力',
    subItems: [
      { key: 'responsibility', label: '职责履行', minScore: 0, maxScore: 3,
        criteria: '2-3分：担任骨干、课代表、"三互"小组长时，认真履行岗位职责，及时传达上级通知，主动反馈同学思想/学习/训练情况，积极开展有意义活动，在所管其辖有积极作为；1分：基本履行骨干职责，但存在通知传达拖延、信息反馈遗漏等问题；0分：不履行骨干职责，对分内工作敷衍了事' },
      { key: 'ability', label: '能力表现', minScore: 0, maxScore: 3,
        criteria: '2-3分：语言表达清晰准确、逻辑严谨，组织策划中队、班级、小组等各级活动有条理，沟通协调能有效解决同学间矛盾、协调各项事务；1分：能力一般，基本能完成组织协调任务，但活动效果、问题解决效果不佳；0分：能力欠缺，无法完成基本的语言表达、组织策划、沟通协调任务' },
      { key: 'activity', label: '活动组织', minScore: 0, maxScore: 2,
        criteria: '1-2分：值班或组织活动时，任务安排合理、流程清晰，活动效果良好，得到同学和干部教员的肯定；0分：组织值班、活动时安排混乱，出现明显失误，严重影响活动/值班效果' },
      { key: 'improvement', label: '改进提升', minScore: 0, maxScore: 2,
        criteria: '1-2分：主动反思管理工作中的问题和不足，不断改进工作方法，管理能力有明显提升；0分：不反思、不改进工作问题，管理能力无提升甚至出现下降' }
    ]
  }
];

function App() {
  const [members, setMembers] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [view, setView] = useState('login'); // login, score, dashboard
  const [loginStep, setLoginStep] = useState('class'); // class, member
  const [selectedClass, setSelectedClass] = useState('');
  const [targetMember, setTargetMember] = useState(null);
  const [isPublicView, setIsPublicView] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [showAdminPasswordModal, setShowAdminPasswordModal] = useState(false);
  const [showAdminNicknameModal, setShowAdminNicknameModal] = useState(false);
  const [adminNicknameInput, setAdminNicknameInput] = useState('');
  const [adminUsernameInput, setAdminUsernameInput] = useState('');
  const [adminPasswordInput, setAdminPasswordInput] = useState('');
  // 暂存真实密码供 set-nickname 接口使用（避免清空 adminPasswordInput 后丢失）
  const adminPasswordStashRef = useRef('');
  // 心理数据修改相关状态
  const [showPsychologyEditModal, setShowPsychologyEditModal] = useState(false);
  const [psychologyEditMember, setPsychologyEditMember] = useState(null);
  const [psychologyEditData, setPsychologyEditData] = useState({
    positiveNominations: [],
    negativeNominations: [],
    moodTag: null,
    selfAssessment: null
  });
  const [psychologyEditType, setPsychologyEditType] = useState('all'); // 'nominations' | 'mood' | 'selfAssessment' | 'all'
  const [psychologyEditPositiveClass, setPsychologyEditPositiveClass] = useState(null);
  const [psychologyEditNegativeClass, setPsychologyEditNegativeClass] = useState(null);
  const [showSetPasswordModal, setShowSetPasswordModal] = useState(false);
  const [newPasswordInput, setNewPasswordInput] = useState('');
  const [confirmPasswordInput, setConfirmPasswordInput] = useState('');
  const [oldPasswordInput, setOldPasswordInput] = useState('');
  // 班级管理相关状态
  const [showClassManagementModal, setShowClassManagementModal] = useState(false);
  const [classList, setClassList] = useState([]);
  const [selectedClassForManagement, setSelectedClassForManagement] = useState(null);
  const [classMembers, setClassMembers] = useState([]);
  const [selectedNewMonitor, setSelectedNewMonitor] = useState(null);
  const [classManagementPassword, setClassManagementPassword] = useState('');
  const [loadingClassMembers, setLoadingClassMembers] = useState(false);
  // 初始化评分状态：为每个二级标准设置默认值
  const [subItemScores, setSubItemScores] = useState(() => {
    const initialScores = {};
    dimensions.forEach(dim => {
      dim.subItems.forEach(subItem => {
        initialScores[`${dim.key}_${subItem.key}`] = subItem.minScore;
      });
    });
    return initialScores;
  });
  
  // 计算最终的六维评分
  const getDimensionScores = () => {
    const dimensionScores = {};
    dimensions.forEach(dim => {
      const totalScore = dim.subItems.reduce((sum, subItem) => {
        return sum + (subItemScores[`${dim.key}_${subItem.key}`] || subItem.minScore);
      }, 0);
      const maxPossibleScore = dim.subItems.reduce((sum, subItem) => sum + subItem.maxScore, 0);
      // 转换为10分制
      dimensionScores[dim.key] = Math.round((totalScore / maxPossibleScore) * 10 * 10) / 10;
    });
    return dimensionScores;
  };
  const [stats, setStats] = useState([]);
  const [config, setConfig] = useState({ currentWeek: 1 });
  const [selectedSemesterId, setSelectedSemesterId] = useState(null); // null 表示当前学期
  const [selectedWeek, setSelectedWeek] = useState(1);
  const [availableScoringWeeks, setAvailableScoringWeeks] = useState([]);
  const [scoredMemberIds, setScoredMemberIds] = useState([]);
  const [notification, setNotification] = useState({ show: false, message: '', type: 'success' });
  const [analysisResult, setAnalysisResult] = useState('');
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [showAnalysisModal, setShowAnalysisModal] = useState(false);
  const [showAnalysisLoader, setShowAnalysisLoader] = useState(false);
  const [showAnalysisNoteModal, setShowAnalysisNoteModal] = useState(false);
  const [analysisNote, setAnalysisNote] = useState('');
  const [pendingAnalysisMemberId, setPendingAnalysisMemberId] = useState(null);
  const [queueStatus, setQueueStatus] = useState({ inQueue: false, queuePosition: null, queueId: null });
  const [isPolling, setIsPolling] = useState(false);
  const [pollingInterval, setPollingInterval] = useState(null);
  const [pendingMember, setPendingMember] = useState(null);
  const [passwordInput, setPasswordInput] = useState('');
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [passwordMode, setPasswordMode] = useState('verify');
  const [showMemberDetailModal, setShowMemberDetailModal] = useState(false);
  const [selectedMemberDetail, setSelectedMemberDetail] = useState(null);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadFile, setUploadFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadType, setUploadType] = useState('academic');
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [profileFormData, setProfileFormData] = useState({ mbti: '', birthday: '', isBackbone: false, position: '', hobbies: '', hometown: '' });
  const [showMBTIDetail, setShowMBTIDetail] = useState(false);
  const [playModeClasses, setPlayModeClasses] = useState([]);
  const [playConf, setPlayConf] = useState(null);        // /api/playmode 配置
  const [playFrames, setPlayFrames] = useState([]);      // 展开后的轮播 slide
  const [playFrameIdx, setPlayFrameIdx] = useState(0);   // 当前 slide 下标
  const [playKeepAlive, setPlayKeepAlive] = useState(3); // 网页保活上限
  const [urlKept, setUrlKept] = useState([]);            // 保活网页 [{key,url,label,last}]
  const keepUrlRef = useRef(3);
  const [isPlayModeLoading, setIsPlayModeLoading] = useState(false);
  const [showMaintenanceModal, setShowMaintenanceModal] = useState(false);
  const [weekInput, setWeekInput] = useState('');
  const [semesterEditMap, setSemesterEditMap] = useState({}); // 学期起点日期编辑缓存 { semesterId: startDate }
  const [restoreBackupFile, setRestoreBackupFile] = useState(null);
  const [restoringBackup, setRestoringBackup] = useState(false);
  const [showRankUploadModal, setShowRankUploadModal] = useState(false);
  const [rankUploadFile, setRankUploadFile] = useState(null);
  const [rankUploading, setRankUploading] = useState(false);
  const [selectedMemberRank, setSelectedMemberRank] = useState(null);
  const [showAcademicScores, setShowAcademicScores] = useState(false);
  const [showFitnessScores, setShowFitnessScores] = useState(false);
  const [updateNotices, setUpdateNotices] = useState({ updateNotice: '', downloadLink: '', contact: '' });
  const [showEditNoticeModal, setShowEditNoticeModal] = useState(false);
  const [editNoticeForm, setEditNoticeForm] = useState({ updateNotice: '', downloadLink: '', contact: '' });
  const [fitnessMonth, setFitnessMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const [selectedFitnessItem, setSelectedFitnessItem] = useState(null);
  const [allFitnessScores, setAllFitnessScores] = useState([]);
  const [allRankScores, setAllRankScores] = useState([]);
  const [entropyWeights, setEntropyWeights] = useState({
    study: 2.0,
    fitness: 2.0,
    literacy: 1.5,
    discipline: 2.0,
    contribution: 1.5,
    management: 1.0
  });
  const [showGuideModal, setShowGuideModal] = useState(false);
  const [showPdfPreview, setShowPdfPreview] = useState(false);
  const [expandedWeek, setExpandedWeek] = useState(null);
  const [expandedEvaluator, setExpandedEvaluator] = useState(null);
  const [expandedSubItems, setExpandedSubItems] = useState(null);
  const [memberFiles, setMemberFiles] = useState([]);
  const [showFilePreview, setShowFilePreview] = useState(null);
  const [currentTempFileName, setCurrentTempFileName] = useState(null);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [textFileContent, setTextFileContent] = useState('');
  const [loadingTextFile, setLoadingTextFile] = useState(false);
  
  // PDF预览相关状态（会员文件）
  const [pdfNumPages, setPdfNumPages] = useState(null);
  const [pdfPageNumber, setPdfPageNumber] = useState(1);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState(null);
  
  // 评分细则PDF预览相关状态
  const [guidePdfNumPages, setGuidePdfNumPages] = useState(null);
  const [guidePdfPageNumber, setGuidePdfPageNumber] = useState(1);
  const [guidePdfLoading, setGuidePdfLoading] = useState(false);
  const [guidePdfError, setGuidePdfError] = useState(null);
  
  // APK更新相关状态
  const [showApkUploadModal, setShowApkUploadModal] = useState(false);
  const [apkFile, setApkFile] = useState(null);
  const [apkVersion, setApkVersion] = useState('1.0.0');
  const [apkVersionCode, setApkVersionCode] = useState('1');
  const [apkUpdateRequired, setApkUpdateRequired] = useState(false);
  const [apkReleaseNotes, setApkReleaseNotes] = useState('');
  const [uploadingApk, setUploadingApk] = useState(false);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [downloadingUpdate, setDownloadingUpdate] = useState(false);
  
  // 版本号管理相关状态
  const [currentVersionInfo, setCurrentVersionInfo] = useState(null);
  const [showSetVersionModal, setShowSetVersionModal] = useState(false);
  const [settingVersion, setSettingVersion] = useState(false);
  
  // 微信Bot连接相关状态
  const [wechatStatus, setWechatStatus] = useState(null);
  const [showWechatConnect, setShowWechatConnect] = useState(false);
  const [wechatBindStep, setWechatBindStep] = useState('idle');
  const [wechatBindMemberId, setWechatBindMemberId] = useState('');
  const [wechatMode, setWechatMode] = useState(null); // null | 'admin' | 'member'
  const [adminBotInfo, setAdminBotInfo] = useState(null);
  const [adminBotLoggedIn, setAdminBotLoggedIn] = useState(false);
  const [adminStep, setAdminStep] = useState(null);
  const [adminMemberId, setAdminMemberId] = useState(() => localStorage.getItem('adminBotMemberId'));
  
  // 经历相关状态
  const [showExperiencesModal, setShowExperiencesModal] = useState(false);
  const [experiences, setExperiences] = useState([]);
  const [experienceType, setExperienceType] = useState('activity');
  const [experienceForm, setExperienceForm] = useState({
    activityName: '',
    activityAward: '',
    competitionName: '',
    competitionLevel: 'school',
    competitionAward: '',
    researchName: '',
    researchHasAdvisor: false,
    honorContent: '',
    honorTime: ''
  });
  const [loadingExperiences, setLoadingExperiences] = useState(false);

  // 六个板块弹窗状态
  const [showAcademicModal, setShowAcademicModal] = useState(false); // 学习成绩
  const [showFitnessModal, setShowFitnessModal] = useState(false); // 体能素质
  const [showLiteracyModal, setShowLiteracyModal] = useState(false); // 人文素养
  const [showDisciplineModal, setShowDisciplineModal] = useState(false); // 遵章守纪
  const [showContributionModal, setShowContributionModal] = useState(false); // 班级贡献
  const [showManagementModal, setShowManagementModal] = useState(false); // 管理能力
  const [expandedFitnessItem, setExpandedFitnessItem] = useState(null); // 展开的体能项目
  const [lastWeekSubScores, setLastWeekSubScores] = useState(null); // 上周二级评分
  
  // 辅助填写功能相关状态
  const [assistModeEnabled, setAssistModeEnabled] = useState(false); // 辅助填写模式开关
  const [loadingLastWeekScores, setLoadingLastWeekScores] = useState(false); // 加载上周评分中
  const [scoreWarnings, setScoreWarnings] = useState([]); // 评分警告列表
  const [assistSource, setAssistSource] = useState('lastweek'); // 辅助来源：lastweek/avg/custom
  const [showScoreWarningModal, setShowScoreWarningModal] = useState(false); // 评分警告弹窗
  const [pendingSubmit, setPendingSubmit] = useState(false); // 是否有待提交的评分
  const [showAssistIntroModal, setShowAssistIntroModal] = useState(false); // 辅助填写介绍弹窗
  const [consecutiveWeeksScores, setConsecutiveWeeksScores] = useState(null); // 连续两周评分数据
  const [showWeeklyReportUpload, setShowWeeklyReportUpload] = useState(false); // 通报上传弹窗
  const [weeklyReportFile, setWeeklyReportFile] = useState(null); // 通报文件
  const [weeklyReportLoading, setWeeklyReportLoading] = useState(false); // 通报上传中
  const [weeklyReportResult, setWeeklyReportResult] = useState(null); // 通报上传结果
  const [showWeeklyReportViewer, setShowWeeklyReportViewer] = useState(false); // 通报查看弹窗
  const [weeklyReportsList, setWeeklyReportsList] = useState([]); // 可用周次列表
  const [weeklyReportDetail, setWeeklyReportDetail] = useState(null); // 选中周次详情
  const [disciplineScores, setDisciplineScores] = useState({}); // 遵章守纪总分
  
  // 补评管理相关
  const [showMakeupModal, setShowMakeupModal] = useState(false); // 补评管理弹窗
  const [makeupPeriods, setMakeupPeriods] = useState([]); // 补评周期列表
  const [newMakeupWeek, setNewMakeupWeek] = useState(1); // 新补评周次
  const [newMakeupEndTime, setNewMakeupEndTime] = useState(''); // 新补评截止时间
  const [newMakeupDescription, setNewMakeupDescription] = useState(''); // 新补评描述
  
  // 雷达图点击状态
  const [selectedRadarWeek, setSelectedRadarWeek] = useState(null); // 选中的雷达图周次
  const [selectedRadarMember, setSelectedRadarMember] = useState(null); // 选中的成员
  
  // BMI数据录入相关状态
  const [showBMIModal, setShowBMIModal] = useState(false);
  const [bmiPassword, setBmiPassword] = useState('');
  const [bmiWeeks, setBmiWeeks] = useState([]);
  
  // ========== 心理气象站相关状态 ==========
  const [showPsychologicalStationModal, setShowPsychologicalStationModal] = useState(false);
  const [psychologicalStationTab, setPsychologicalStationTab] = useState('alerts'); // alerts, social-map, compatibility, report
  const [loadingPsychologicalData, setLoadingPsychologicalData] = useState(false);
  
  // 预警看板数据
  const [alertData, setAlertData] = useState(null);
  const [alertPage, setAlertPage] = useState(1);
  const [alertsPerPage] = useState(10);
  
  // 社交地图数据
  const [socialMapData, setSocialMapData] = useState(null);
  const [selectedMapMemberId, setSelectedMapMemberId] = useState(null);
  const [selectedMapClass, setSelectedMapClass] = useState('');
  const [mapToolMode, setMapToolMode] = useState('view'); // view, focus-island, group, bridge
  const [detectedIslands, setDetectedIslands] = useState([]);
  const [detectedGroups, setDetectedGroups] = useState([]);
  const [selectedGroups, setSelectedGroups] = useState([]);
  const [selectedBridgeGroups, setSelectedBridgeGroups] = useState([]); // 桥梁人模式选中的小团体
  const [recommendedBridges, setRecommendedBridges] = useState([]);
  const [interventionSuggestion, setInterventionSuggestion] = useState(null);
  
  // 相容性分析数据
  const [compatibilityData, setCompatibilityData] = useState(null);
  const [selectedMemberA, setSelectedMemberA] = useState(null);
  const [selectedMemberB, setSelectedMemberB] = useState(null);
  const [compatibilityClassA, setCompatibilityClassA] = useState(null);
  const [compatibilityClassB, setCompatibilityClassB] = useState(null);
  const [compatibilityReport, setCompatibilityReport] = useState('');
  const [isCompatibilityLoading, setIsCompatibilityLoading] = useState(false);
  const [compatibilityError, setCompatibilityError] = useState(null);
  const compatibilityRef = useRef(null);
  const compatibilityAutoScroll = useRef(true);
  
  // 预警看板弹窗状态
  const [showAlertModal, setShowAlertModal] = useState(false);
  const [selectedAlertType, setSelectedAlertType] = useState(null);
  
  // 工作简报数据
  const [weeklyReportData, setWeeklyReportData] = useState(null);
  
  // 心理咨询相关状态
  const [counselingMemberId, setCounselingMemberId] = useState(null);
  const [counselingClass, setCounselingClass] = useState(null);
  const [counselingNotes, setCounselingNotes] = useState('');
  const [counselingReport, setCounselingReport] = useState('');
  const [isCounselingLoading, setIsCounselingLoading] = useState(false);
  const [counselingError, setCounselingError] = useState(null);
  const counselingRef = useRef(null);
  const counselingAutoScroll = useRef(true);
  // 追加提问相关状态
  const [followUpQuestion, setFollowUpQuestion] = useState('');
  const [isFollowUpLoading, setIsFollowUpLoading] = useState(false);
  const [followUpError, setFollowUpError] = useState(null);
  const [conversationHistory, setConversationHistory] = useState([]);
  const [counselingPrompt, setCounselingPrompt] = useState('');
  
  // 每日打卡反馈相关状态
  const [showDailyCheckin, setShowDailyCheckin] = useState(false);
  const [showDailyQuestion, setShowDailyQuestion] = useState(false);
  // JPush 诊断日志（移动端排查推送注册失败用）
  const [pushDebugLogs, setPushDebugLogs] = useState([]);
  const [showPushDebug, setShowPushDebug] = useState(false);
  // 前台服务诊断日志（独立进程的轮询日志）
  const [fgServiceInfo, setFgServiceInfo] = useState(null);
  // 后台保活权限引导弹窗（自启动/电池优化/后台活动）
  const [showPermissionGuide, setShowPermissionGuide] = useState(false);
  const [permCheckResult, setPermCheckResult] = useState({ batteryIgnored: null, brand: '' });
  const btnStyle = {
    padding: '10px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
    background: '#6366f1', color: 'white', fontSize: 13, fontWeight: 500
  };
  const pushLog = (msg, level = 'info') => {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setPushDebugLogs(prev => [...prev, { time, msg: String(msg), level }]);
    if (level === 'error') console.error('[PushDiag]', msg);
    else if (level === 'warn') console.warn('[PushDiag]', msg);
    else console.log('[PushDiag]', msg);
  };
  const [showWeeklyNote, setShowWeeklyNote] = useState(false);
  const [showAdminCheckin, setShowAdminCheckin] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [pendingAgentContext, setPendingAgentContext] = useState(null);
  
  const followUpRef = useRef(null);
  const analysisRef = useRef(null);
  const analysisAutoScroll = useRef(true);
  
  // 关系提名和心情标签（评分界面）
  const [positiveNominations, setPositiveNominations] = useState([]);
  const [negativeNominations, setNegativeNominations] = useState([]);
  const [positiveNominationClass, setPositiveNominationClass] = useState(currentUser?.class || null);
  const [negativeNominationClass, setNegativeNominationClass] = useState(currentUser?.class || null);
  const [selectedMoodTag, setSelectedMoodTag] = useState(null);
  const [moodTags, setMoodTags] = useState([]);
  
  // 心理状态自评（评分界面）
  const [selfAssessment, setSelfAssessment] = useState({
    sleepQuality: 5,
    emotionalState: 5,
    stressLevel: 5,
    appetiteLevel: 5,
    roommateRelation: 5,
    copingStyle: []
  });
  const copingOptions = ['倾诉', '运动', '写作', '听音乐', '打游戏', '吃东西', '睡觉', '独自消化', '寻求专业帮助'];
  const [selectedBMIWeek, setSelectedBMIWeek] = useState(null);
  const [bmiData, setBmiData] = useState({});
  const [fixedHeights, setFixedHeights] = useState({});
  const [expandedBMIClass, setExpandedBMIClass] = useState(null);
  const [savingBMI, setSavingBMI] = useState(false);
  const [bmiCalendarMonth, setBmiCalendarMonth] = useState(new Date());
  const [showBMIUploadModal, setShowBMIUploadModal] = useState(false);
  const [bmiUploadFile, setBmiUploadFile] = useState(null);
  const [bmiUploading, setBmiUploading] = useState(false);
  const [allBMIData, setAllBMIData] = useState([]);
  const [showAllBMIModal, setShowAllBMIModal] = useState(false);
  
  // BMI展示相关状态
  const [bmiDisplayData, setBmiDisplayData] = useState({ weeks: [], members: [] });
  const [showBMIDisplayModal, setShowBMIDisplayModal] = useState(false);
  
  // 周总结相关状态
  const [showWeekSummaryModal, setShowWeekSummaryModal] = useState(false);
  const [availableWeeks, setAvailableWeeks] = useState([]);
  const [selectedSummaryWeek, setSelectedSummaryWeek] = useState(null);
  const [weekSummaryData, setWeekSummaryData] = useState(null);
  const [loadingWeekSummary, setLoadingWeekSummary] = useState(false);
  
  // 注意事项弹窗状态
  const [showDisclaimerModal, setShowDisclaimerModal] = useState(false);
  const [disclaimerAgreed, setDisclaimerAgreed] = useState(false);
  const [countdownSeconds, setCountdownSeconds] = useState(2);
  const [isSliding, setIsSliding] = useState(false);
  const [slidePosition, setSlidePosition] = useState(0);
  
  // 修改评分数据相关状态
  const [showEditScoreModal, setShowEditScoreModal] = useState(false);
  const [editScoreWeek, setEditScoreWeek] = useState(null);
  const [editScoreMember, setEditScoreMember] = useState(null);
  const [editScoreEvaluator, setEditScoreEvaluator] = useState(null);
  const [editScoreData, setEditScoreData] = useState(null);
  const [editScoreSaving, setEditScoreSaving] = useState(false);
  
  // 修改BMI数据相关状态
  const [showEditBMIModal, setShowEditBMIModal] = useState(false);
  const [editBMIWeek, setEditBMIWeek] = useState(null);
  const [editBMIAllData, setEditBMIAllData] = useState({});
  const [editBMISaving, setEditBMISaving] = useState(false);
  
  // 通知相关状态
  const [notifications, setNotifications] = useState([]);
  const [showNotificationsModal, setShowNotificationsModal] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  
  // 通报相关状态
  const [showNoticeModal, setShowNoticeModal] = useState(false);
  const [showNoticePasswordModal, setShowNoticePasswordModal] = useState(false);
  const [noticePassword, setNoticePassword] = useState('');
  const [notices, setNotices] = useState([]);
  const [noticeForm, setNoticeForm] = useState({
    class: '',
    memberId: '',
    content: '',
    time: new Date().toISOString().split('T')[0]
  });
  const [savingNotice, setSavingNotice] = useState(false);
  
  // 公差相关状态
  const [showDutyModal, setShowDutyModal] = useState(false);
  const [duties, setDuties] = useState([]);
  const [targetMemberDuties, setTargetMemberDuties] = useState([]);
  const [dutyStats, setDutyStats] = useState({});
  const [dutyForm, setDutyForm] = useState({
    memberIds: [],
    content: '',
    time: new Date().toISOString().split('T')[0],
    score: ''
  });
  const [savingDuty, setSavingDuty] = useState(false);

  const classes = [...new Set(members.map(m => m.class))].sort((a, b) => {
    // Sort by predefined class monitor names, unknown classes at the end
    const order = ["樊宇博班", "杨啸班", "谢伟峰班", "卢泽卿班", "刘子翔班", "丁丕硕班", "杨东锦班", "韩雨彪班", "梁续班", "肖润新班", "杨露班"];
    const orderA = order.indexOf(a);
    const orderB = order.indexOf(b);
    
    // If both are in the predefined list, sort by their order
    if (orderA !== -1 && orderB !== -1) {
      return orderA - orderB;
    }
    
    // If only one is in the predefined list, put it first
    if (orderA !== -1) return -1;
    if (orderB !== -1) return 1;
    
    // If neither is in the predefined list, sort alphabetically
    return a.localeCompare(b);
  });

  const filteredMembers = members.filter(m => m.class === selectedClass);

  // 优化的详情页面数据计算
  const memberRankData = useMemo(() => {
    if (!selectedMemberRank) return null;
    
    const validSemesterScores = selectedMemberRank.semesterScores ? 
      selectedMemberRank.semesterScores.filter(s => s.semester !== '总') : [];
    
    const sortedSemesterScores = validSemesterScores.slice(-3).reverse();
    
    const yearRanks = selectedMemberRank.yearRanks ? 
      selectedMemberRank.yearRanks.filter(yr => yr.name && yr.name !== '总排名变化') : [];
    
    const totalRankChange = selectedMemberRank.yearRanks ? 
      selectedMemberRank.yearRanks.find(yr => yr.name === '总排名变化') : null;
    
    const currentTotalRank = selectedMemberRank.semesterScores ? 
      selectedMemberRank.semesterScores.find(s => s.semester === '总') : null;
    
    const hasYearRanks = yearRanks.length > 0;
    const hasCurrentTotal = !!currentTotalRank;
    const showTotalRankSection = hasYearRanks || hasCurrentTotal;
    
    return {
      validSemesterScores,
      sortedSemesterScores,
      yearRanks,
      totalRankChange,
      currentTotalRank,
      showTotalRankSection
    };
  }, [selectedMemberRank]);

  const semesterRankChangeDisplay = useMemo(() => {
    if (!selectedMemberRank || selectedMemberRank.latestSemesterRankChange === undefined) {
      return null;
    }
    
    const change = selectedMemberRank.latestSemesterRankChange;
    let text = '';
    let colorClass = '';
    
    if (change > 0) {
      text = `进步${Math.abs(change)}名`;
      colorClass = 'text-green-600';
    } else if (change < 0) {
      text = `退步${Math.abs(change)}名`;
      colorClass = 'text-red-600';
    } else {
      text = '不变';
      colorClass = 'text-gray-600';
    }
    
    return { text, colorClass };
  }, [selectedMemberRank?.latestSemesterRankChange]);

  const academicScoresDisplay = useMemo(() => {
    if (!selectedMemberDetail?.academicScores?.[0]) return null;
    
    const scores = selectedMemberDetail.academicScores[0].scores;
    
    const filteredScores = Object.entries(scores).filter(entry => {
      if (entry[0] === '序列') return false;
      if (entry[0] === '备注') {
        const val = entry[1];
        if (val === null || val === undefined || (typeof val === 'string' && val.trim() === '')) {
          return false;
        }
      }
      return true;
    });
    
    const validScoresForAvg = Object.entries(scores)
      .filter(entry => entry[0] !== '序列' && entry[0] !== '备注' && typeof entry[1] === 'number' && !isNaN(entry[1]));
    
    let averageScore = '-';
    if (validScoresForAvg.length > 0) {
      const sum = validScoresForAvg.reduce((sum, entry) => sum + entry[1], 0);
      averageScore = (sum / validScoresForAvg.length).toFixed(2);
    }
    
    const failCount = validScoresForAvg.filter(entry => entry[1] < 60).length;
    
    return {
      filteredScores,
      averageScore,
      failCount
    };
  }, [selectedMemberDetail?.academicScores]);

  // 解析三千米成绩（支持多种格式）
  const parseThreeKilometerTime = (timeStr) => {
    if (!timeStr) return null;
    let str = String(timeStr).trim();
    
    // 格式2: 13'35, 16'05, 13'50" (分钟'秒)
    const match1 = str.match(/(\d+)['’](\d+)/);
    if (match1) {
      return parseInt(match1[1]) * 60 + parseInt(match1[2]);
    }
    
    // 格式3: 13:35, 16:05 (分钟:秒)
    const match2 = str.match(/(\d+):(\d+)/);
    if (match2) {
      return parseInt(match2[1]) * 60 + parseInt(match2[2]);
    }
    
    // 格式4: 13.35, 16.05 (分钟.秒)
    const match3 = str.match(/(\d+)\.(\d+)/);
    if (match3) {
      return parseInt(match3[1]) * 60 + parseInt(match3[2]);
    }
    
    // 格式1: 全数字（3-4位优先解析为分钟+秒）
    const digitsOnly = str.replace(/[^0-9]/g, '');
    if (digitsOnly.length >= 3 && digitsOnly.length <= 4) {
      let minutes, seconds;
      if (digitsOnly.length === 4) {
        minutes = parseInt(digitsOnly.substring(0, 2));
        seconds = parseInt(digitsOnly.substring(2, 4));
      } else { // 3位数字，如850 → 8分50秒
        minutes = parseInt(digitsOnly.substring(0, 1));
        seconds = parseInt(digitsOnly.substring(1, 3));
      }
      if (!isNaN(minutes) && !isNaN(seconds)) {
        return minutes * 60 + seconds;
      }
    }
    
    // 格式5: 直接秒数（只有在数字长度不是3-4位时才使用）
    if (digitsOnly.length < 3 || digitsOnly.length > 4) {
      const num = parseFloat(str);
      if (!isNaN(num)) {
        return num;
      }
    }
    
    return null;
  };

  // 解析蛇形跑成绩（支持多种格式）
  const parseSnakeRunTime = (timeStr) => {
    if (!timeStr) return null;
    let str = String(timeStr).trim();
    
    // 格式2: 20"4 → 20.4秒
    const match1 = str.match(/(\d+)"(\d+)/);
    if (match1) {
      return parseFloat(match1[1] + '.' + match1[2]);
    }
    
    // 格式3: 20'4 → 20.4秒
    const match2 = str.match(/(\d+)['’](\d+)/);
    if (match2) {
      return parseFloat(match2[1] + '.' + match2[2]);
    }
    
    // 格式4: 20:4 → 20.4秒
    const match3 = str.match(/(\d+):(\d+)/);
    if (match3) {
      return parseFloat(match3[1] + '.' + match3[2]);
    }
    
    // 格式1: 直接数字（秒）或全数字（如204 → 20.4秒）
    const digitsOnly = str.replace(/[^0-9]/g, '');
    if (digitsOnly.length === 3) {
      // 3位数字如204 → 20.4秒
      return parseFloat(digitsOnly.substring(0, 2) + '.' + digitsOnly.substring(2, 3));
    }
    
    // 直接数字格式（如20.4）
    const num = parseFloat(str);
    if (!isNaN(num)) {
      return num;
    }
    
    return null;
  };

  // 格式化三千米成绩显示
  const formatThreeKilometerScore = (score) => {
    if (score === null || score === undefined) return score;
    const scoreStr = String(score).trim();
    if (scoreStr === '' || scoreStr === '未参考') return score;
    
    // 如果已经是带分隔符的格式，直接返回
    if (scoreStr.includes("'") || scoreStr.includes('"') || scoreStr.includes(':') || scoreStr.includes('′') || scoreStr.includes('″')) {
      return score;
    }
    
    // 尝试解析为数字
    const parsed = parseThreeKilometerTime(score);
    if (parsed !== null) {
      const minutes = Math.floor(parsed / 60);
      const seconds = Math.round(parsed % 60);
      return `${minutes}'${String(seconds).padStart(2, '0')}"`;
    }
    
    return score;
  };

  // 格式化蛇形跑成绩显示
  const formatSnakeRunScore = (score) => {
    if (score === null || score === undefined) return score;
    const scoreStr = String(score).trim();
    if (scoreStr === '' || scoreStr === '未参考') return score;
    
    // 如果已经是带小数点的格式，直接返回
    if (scoreStr.includes('.') || scoreStr.includes("'") || scoreStr.includes('"') || scoreStr.includes(':') || scoreStr.includes('′') || scoreStr.includes('″')) {
      return score;
    }
    
    // 尝试解析为数字
    const parsed = parseSnakeRunTime(score);
    if (parsed !== null) {
      return parsed.toFixed(1);
    }
    
    return score;
  };

  // 格式化体能成绩显示
  const formatFitnessScore = (itemName, score) => {
    if (itemName === '三千米' || itemName === '3000米') {
      return formatThreeKilometerScore(score);
    } else if (itemName === '蛇形跑') {
      return formatSnakeRunScore(score);
    }
    return score;
  };

  // 判断是否为女班学员（ID区间 1101-1113）
  const isFemaleMember = (memberId) => {
    if (!memberId) return false;
    const id = String(memberId);
    return id >= '1101' && id <= '1113';
  };

  // 判断体能成绩是否及格
  const isFitnessScorePass = (itemName, score, isFemale) => {
    if (score === null || score === undefined) return true;
    
    const scoreStr = String(score).trim();
    if (scoreStr === '' || scoreStr === '未参考') return true;
    
    // BMI单独判断
    if (itemName === 'BMI') {
      const bmi = parseFloat(scoreStr);
      if (isNaN(bmi)) return true;
      const minBMI = 18.5;
      const maxBMI = isFemale ? 23.9 : 25.9;
      return bmi >= minBMI && bmi <= maxBMI;
    }
    
    // 及格标准
    const standards = {
      '三千米': { male: 13 * 60 + 35, female: 16 * 60 + 5, isTime: true },
      '3000米': { male: 13 * 60 + 35, female: 16 * 60 + 5, isTime: true },
      '仰卧卷腹': { male: 35, female: 27, isTime: false },
      '蛇形跑': { male: 20.4, female: 22.2, isTime: true },
      '曲臂悬垂': { male: 11, female: 36, isTime: false },
      '单杠': { male: 11, female: 36, isTime: false },
      '引体向上': { male: 11, female: 36, isTime: false },
      '曲臂悬垂/单杠': { male: 11, female: 36, isTime: false }
    };
    
    // 标准化项目名称
    let standardItemName = itemName;
    if (itemName === '屈臂悬垂' || itemName === '曲臂悬垂' || itemName === '单杠' || itemName === '引体向上' || itemName === '屈臂悬垂/单杠' || itemName === '曲臂悬垂/单杠' || itemName === '单杠/引体向上') {
      standardItemName = '曲臂悬垂/单杠';
    } else if (itemName === '3000米') {
      standardItemName = '三千米';
    }
    
    const standard = standards[standardItemName];
    if (!standard) return true;
    
    const passValue = isFemale ? standard.female : standard.male;
    
    if (standard.isTime && standardItemName === '三千米') {
      // 三千米：时间越短越好，超过及格时间则不及格
      const timeInSeconds = parseThreeKilometerTime(score);
      if (timeInSeconds === null) return true;
      return timeInSeconds <= passValue;
    } else if (standard.isTime && standardItemName === '蛇形跑') {
      // 蛇形跑：时间越短越好
      const timeValue = parseSnakeRunTime(score);
      if (timeValue === null) return true;
      return timeValue <= passValue;
    } else if (standard.isTime) {
      // 其他时间项目：时间越短越好
      const timeValue = parseFloat(scoreStr);
      if (isNaN(timeValue)) return true;
      return timeValue <= passValue;
    } else {
      // 计数项目：数量越多越好
      const countValue = parseFloat(scoreStr);
      if (isNaN(countValue)) return true;
      return countValue >= passValue;
    }
  };

  const fitnessScoresDisplay = useMemo(() => {
    if (!selectedMemberDetail?.fitnessScores?.[0]) return { hasUnreference: false, hasFail: false };
    
    const fitnessData = selectedMemberDetail.fitnessScores[0];
    
    let history = fitnessData.history || [];
    let latestScores = {};
    
    if (history.length === 0 && fitnessData.scores) {
      latestScores = fitnessData.scores;
    } else if (history.length > 0) {
      const latestHistory = [...history].sort((a, b) => b.month.localeCompare(a.month))[0];
      latestScores = latestHistory.scores;
    } else {
      return { hasUnreference: false, hasFail: false };
    }
    
    const isFemale = isFemaleMember(selectedMemberDetail.member?.id);
    
    // 从体测数据中获取身高体重
    let heightFromFitness = latestScores['身高'];
    let weightFromFitness = latestScores['体重'];
    
    // 计算自动BMI
    let autoBMI = null;
    if (heightFromFitness && weightFromFitness) {
      let height = parseFloat(heightFromFitness);
      let weight = parseFloat(weightFromFitness);
      
      // 处理身高可能是米为单位的情况（小于3米时，转换为厘米）
      if (!isNaN(height) && height > 0 && height < 3) {
        height = height * 100;
      }
      
      if (!isNaN(height) && !isNaN(weight) && height > 0 && weight > 0) {
        const heightInMeters = height / 100;
        autoBMI = weight / (heightInMeters * heightInMeters);
        autoBMI = Math.round(autoBMI * 10) / 10;
      }
    }
    
    const fitnessItems = ['三千米', '仰卧卷腹', '蛇形跑', '曲臂悬垂', '单杠', '曲臂悬垂/单杠', '屈臂悬垂/单杠'];
    
    const hasUnreference = Object.entries(latestScores).some(([item, score]) => {
      if (item === '备注' || item === '身高' || item === '体重' || item === 'BMI' || item === '分数') return false;
      const scoreStr = String(score).trim();
      return scoreStr === '' || scoreStr === '未参考';
    });
    
    const hasFail = Object.entries(latestScores).some(([item, score]) => {
      if (item === '备注' || item === '身高' || item === '体重' || item === '分数') return false;
      
      // 如果是BMI项目，使用自动计算的数据
      if (item === 'BMI' && autoBMI !== null) {
        const minBMI = 18.5;
        const maxBMI = isFemale ? 23.9 : 25.9;
        return autoBMI < minBMI || autoBMI > maxBMI;
      }
      
      return !isFitnessScorePass(item, score, isFemale);
    });
    
    return { hasUnreference, hasFail };
  }, [selectedMemberDetail?.fitnessScores, selectedMemberDetail?.member]);

  // 判断每个成员的状态
  const memberStatusMap = useMemo(() => {
    const statusMap = {};
    
    // 安全检查：确保 members, allFitnessScores, allRankScores 都是数组
    const safeMembers = Array.isArray(members) ? members : [];
    const safeFitnessScores = Array.isArray(allFitnessScores) ? allFitnessScores : [];
    const safeRankScores = Array.isArray(allRankScores) ? allRankScores : [];
    
    safeMembers.forEach(member => {
      let hasFitnessFail = false;
      let hasFitnessPass = false;
      let hasInjury = false;
      let hasScoreDecline = false;
      let hasScoreProgress = false;
      
      // 1. 检查体能不及格
      const fitnessData = safeFitnessScores.find(f => f && f.memberId === member.id);
      if (fitnessData) {
        let history = Array.isArray(fitnessData.history) ? fitnessData.history : [];
        let scores = (fitnessData.scores && typeof fitnessData.scores === 'object') ? fitnessData.scores : {};
        
        if (history.length === 0 && Object.keys(scores).length > 0) {
          // 使用 scores 本身
        } else if (history.length > 0) {
          const latestHistory = [...history].sort((a, b) => {
            const monthA = a.month || '';
            const monthB = b.month || '';
            return monthB.localeCompare(monthA);
          })[0];
          scores = (latestHistory.scores && typeof latestHistory.scores === 'object') ? latestHistory.scores : {};
        }
        
        if (Object.keys(scores).length > 0) {
          // 查找身高体重用于BMI自动计算
          let heightFromFitness = scores['身高'];
          let weightFromFitness = scores['体重'];
          let autoBMI = null;
          
          if (heightFromFitness && weightFromFitness) {
            let height = parseFloat(heightFromFitness);
            let weight = parseFloat(weightFromFitness);
            if (!isNaN(height) && !isNaN(weight) && height > 0 && weight > 0) {
              if (height < 3) height = height * 100;
              const heightInMeters = height / 100;
              autoBMI = weight / (heightInMeters * heightInMeters);
              autoBMI = Math.round(autoBMI * 10) / 10;
            }
          }
          
          const isFemale = isFemaleMember(member.id);
          
          // 检查是否有不及格项
          hasFitnessFail = Object.entries(scores).some(([item, score]) => {
            if (item === '备注' || item === '身高' || item === '体重' || item === '分数') return false;
            
            if (item === 'BMI' && autoBMI !== null) {
              const minBMI = 18.5;
              const maxBMI = isFemale ? 23.9 : 25.9;
              return autoBMI < minBMI || autoBMI > maxBMI;
            }
            
            return !isFitnessScorePass(item, score, isFemale);
          });
          
          // 如果没有不及格项，则体能及格
          hasFitnessPass = !hasFitnessFail;
          
          // 检查是否有未参考项
          hasInjury = Object.entries(scores).some(([item, score]) => {
            if (item === '备注' || item === '身高' || item === '体重' || item === '分数' || item === 'BMI') return false;
            const scoreStr = String(score).trim();
            return scoreStr === '' || scoreStr === '未参考';
          });
        }
      }
      
      // 2. 检查学习成绩退步/进步
      const rankData = safeRankScores.find(r => r && r.memberId === member.id);
      if (rankData && Array.isArray(rankData.semesterScores)) {
        const validScores = rankData.semesterScores.filter(s => s && s.semester !== '总');
        if (validScores.length >= 2 && 
            typeof validScores[validScores.length - 1].rank === 'number' && 
            typeof validScores[validScores.length - 2].rank === 'number') {
          const latestScore = validScores[validScores.length - 1];
          const previousScore = validScores[validScores.length - 2];
          // 排名数字越大表示越靠后（退步），越小表示越靠前（进步）
          hasScoreDecline = latestScore.rank > previousScore.rank;
          hasScoreProgress = latestScore.rank < previousScore.rank;
        }
      }
      
      statusMap[member.id] = { hasFitnessFail, hasFitnessPass, hasInjury, hasScoreDecline, hasScoreProgress };
    });
    
    return statusMap;
  }, [members, allFitnessScores, allRankScores]);

  // 初始化Socket连接
  useEffect(() => {
    const socketUrl = getSocketUrl();
    if (socketUrl) {
      socket = io(socketUrl);
    } else {
      socket = io();
    }
    
    socket.on('scoreUpdated', (newScore) => {
      // Refresh stats if viewing dashboard
      if (view === 'dashboard' && targetMember?.id === newScore.memberId) {
        fetchStats(targetMember.id);
      }
      // If the current user submitted this score, refresh the scored IDs list
      if (currentUser && currentUser.id === newScore.evaluatorId && parseInt(newScore.week) === config.currentWeek) {
        fetchScoredIds(currentUser.id, config.currentWeek);
      }
    });

    // 监听公差添加事件
    socket.on('dutyAdded', (newDuty) => {
      // 刷新所有公差数据
      fetchDuties();
      // 刷新公差统计
      fetchDutyStats();
      // 如果正在查看成员详情，刷新公差数据
      if (selectedMemberDetail?.member?.id && newDuty.memberIds.includes(selectedMemberDetail.member.id)) {
        fetchMemberDetail(selectedMemberDetail.member.id);
      }
      // 如果正在评分，刷新目标成员的公差数据
      if (targetMember && newDuty.memberIds.includes(targetMember.id)) {
        fetchTargetMemberDuties(targetMember.id);
      }
    });

    // 监听公差删除事件
    socket.on('dutyDeleted', (data) => {
      // 刷新所有公差数据
      fetchDuties();
      // 刷新公差统计
      fetchDutyStats();
      // 如果正在查看成员详情，刷新公差数据
      if (selectedMemberDetail?.member?.id && data.memberIds.includes(selectedMemberDetail.member.id)) {
        fetchMemberDetail(selectedMemberDetail.member.id);
      }
      // 如果正在评分，刷新目标成员的公差数据
      if (targetMember && data.memberIds.includes(targetMember.id)) {
        fetchTargetMemberDuties(targetMember.id);
      }
    });
    
    return () => {
      socket.off('scoreUpdated');
      socket.off('dutyAdded');
      socket.off('dutyDeleted');
      socket.disconnect();
    };
  }, []);

  // 应用启动时检查更新（只执行一次）
  useEffect(() => {
    checkForUpdate();
  }, []);
  
  // 应用启动时显示注意事项弹窗
  useEffect(() => {
    setShowDisclaimerModal(true);
    setCountdownSeconds(2);
  }, []);

  // 注册Service Worker用于推送通知
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then(reg => console.log('[SW] Registered:', reg.scope))
        .catch(err => console.error('[SW] Register failed:', err));
    }
  }, []);

  useEffect(() => {
    fetchMembers();
    fetchConfig();
    fetchAllFitnessScores();
    fetchAllRankScores();
    fetchFixedHeights();
    fetchEntropyWeights();
    fetchUpdateNotices();
  }, [view, targetMember, currentUser, config.currentWeek]);

  useEffect(() => {
    const fetchWechatStatus = async () => {
      try {
        const res = await axios.get(getFullApiUrl('/api/wechat/status'));
        setWechatStatus(res.data);
      } catch {
        setWechatStatus(null);
      }
    };
    fetchWechatStatus();
    const timer = setInterval(fetchWechatStatus, wechatMode === 'admin' ? 3000 : 10000);
    return () => clearInterval(timer);
  }, [wechatMode]);

  useEffect(() => {
    if (!adminMemberId || adminBotLoggedIn) return;
    const checkBot = async () => {
      try {
        const res = await axios.get(getFullApiUrl('/api/wechat/status'), { params: { memberId: adminMemberId } });
        if (res.data.found) {
          setAdminBotInfo(res.data);
          if (res.data.loggedIn) setAdminBotLoggedIn(true);
        } else {
          setAdminBotInfo(null);
          localStorage.removeItem('adminBotMemberId');
          setAdminMemberId(null);
        }
      } catch {}
    };
    checkBot();
    const timer = setInterval(checkBot, 3000);
    return () => clearInterval(timer);
  }, [adminMemberId, adminBotLoggedIn]);

  useEffect(() => {
    const shouldStop = adminMemberId && adminBotInfo && !adminBotLoggedIn && !adminBotInfo?.loggedIn && showWechatConnect && wechatMode === 'admin';
    if (!shouldStop) return;

    const url = getFullApiUrl('/api/wechat/stop-bot');
    const body = JSON.stringify({ memberId: adminMemberId });
    let sent = false;

    const stopBot = () => {
      if (sent) return;
      sent = true;
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      } else {
        axios.post(url, { memberId: adminMemberId }).catch(() => {});
      }
    };

    window.addEventListener('beforeunload', stopBot);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') stopBot();
    });

    return () => {
      window.removeEventListener('beforeunload', stopBot);
      document.removeEventListener('visibilitychange', stopBot);
    };
  }, [adminMemberId, adminBotInfo, adminBotLoggedIn, showWechatConnect, wechatMode]);

  // 播放调度：按当前 slide 的独立时长推进，末尾回绕；退出播放自动清理
  useEffect(() => {
    if (view !== 'play' || playFrames.length === 0) return;
    const dur = (playFrames[playFrameIdx] && playFrames[playFrameIdx].duration) || 8;
    const t = setTimeout(() => setPlayFrameIdx(p => (p + 1) % playFrames.length), dur * 1000);
    return () => clearTimeout(t);
  }, [view, playFrames, playFrameIdx]);

  // 网页保活挂载：当前/下一帧是网页时入池（隐藏 iframe 保活 → 滚动记忆 + 预热秒开）
  useEffect(() => {
    if (view !== 'play' || playFrames.length === 0) return;
    const cur = playFrames[playFrameIdx];
    const next = playFrames[(playFrameIdx + 1) % playFrames.length];
    if (cur && cur.kind === 'url') mountUrl(cur);
    if (next && next.kind === 'url') mountUrl(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, playFrameIdx, playFrames]);

  // 离开播放：清保活池与帧位
  useEffect(() => {
    if (view !== 'play') { setUrlKept([]); setPlayFrameIdx(0); }
  }, [view]);

  // 保活池：访问过即常驻隐藏 iframe；超上限按最久未显示 LRU 卸载
  const mountUrl = (f) => {
    setUrlKept(prev => {
      const cap = keepUrlRef.current;
      if (cap < 1) return prev;
      const existed = prev.find(x => x.key === f.key);
      let list = existed
        ? prev.map(x => (x.key === f.key ? { ...x, last: Date.now() } : x))
        : [...prev, { key: f.key, url: f.url, label: f.label || f.key, last: Date.now() }];
      if (list.length > cap) {
        const drop = list.filter(x => x.key !== f.key)
          .sort((a, b) => a.last - b.last)
          .slice(0, list.length - cap);
        const dropKeys = new Set(drop.map(x => x.key));
        list = list.filter(x => !dropKeys.has(x.key));
      }
      return list;
    });
  };

  const fetchScoredIds = async (evaluatorId, currentWeek, semesterId) => {
    if (!evaluatorId || !currentWeek) return;
    try {
      const sid = semesterId || selectedSemesterId || config.currentSemesterId;
      const res = await axios.get(getFullApiUrl(`/api/scored-ids/${evaluatorId}/${currentWeek}`), {
        params: sid ? { semesterId: sid } : {}
      });
      setScoredMemberIds(res.data);
    } catch (err) {
      console.error('Failed to fetch scored IDs', err);
    }
  };

  const [configInitialized, setConfigInitialized] = useState(false);

  // PDF加载成功回调
  const onPdfLoadSuccess = useCallback(({ numPages }) => {
    setPdfNumPages(numPages);
    setPdfPageNumber(1);
    setPdfLoading(false);
    setPdfError(null);
  }, []);

  // PDF加载失败回调
  const onPdfLoadError = useCallback((error) => {
    console.error('PDF load error:', error);
    setPdfError('PDF加载失败');
    setPdfLoading(false);
  }, []);

  // 改变PDF页码
  const changePdfPage = useCallback((offset) => {
    setPdfPageNumber((prevPageNumber) => {
      const newPageNumber = prevPageNumber + offset;
      return Math.min(Math.max(newPageNumber, 1), pdfNumPages || 1);
    });
  }, [pdfNumPages]);

  // 重置PDF状态
  const resetPdfState = useCallback(() => {
    setPdfNumPages(null);
    setPdfPageNumber(1);
    setPdfLoading(false);
    setPdfError(null);
  }, []);

  // 评分细则PDF加载成功回调
  const onGuidePdfLoadSuccess = useCallback(({ numPages }) => {
    setGuidePdfNumPages(numPages);
    setGuidePdfPageNumber(1);
    setGuidePdfLoading(false);
    setGuidePdfError(null);
  }, []);

  // 评分细则PDF加载失败回调
  const onGuidePdfLoadError = useCallback((error) => {
    console.error('Guide PDF load error:', error);
    setGuidePdfError('评分细则PDF加载失败');
    setGuidePdfLoading(false);
  }, []);

  // 改变评分细则PDF页码
  const changeGuidePdfPage = useCallback((offset) => {
    setGuidePdfPageNumber((prevPageNumber) => {
      const newPageNumber = prevPageNumber + offset;
      return Math.min(Math.max(newPageNumber, 1), guidePdfNumPages || 1);
    });
  }, [guidePdfNumPages]);

  // 重置评分细则PDF状态
  const resetGuidePdfState = useCallback(() => {
    setGuidePdfNumPages(null);
    setGuidePdfPageNumber(1);
    setGuidePdfLoading(false);
    setGuidePdfError(null);
  }, []);

  const loadTextFileContent = async (tempFileName) => {
    try {
      setLoadingTextFile(true);
      setTextFileContent('');
      const response = await axios.get(getFullApiUrl(`/api/temp-files/${tempFileName}`), {
        responseType: 'text'
      });
      setTextFileContent(response.data);
    } catch (err) {
      console.error('Failed to load text file content:', err);
      setTextFileContent('无法加载文件内容');
    } finally {
      setLoadingTextFile(false);
    }
  };
  
  // 计算指定日期是第几周（与主系统一致）
  const calculateWeek = (date, startDateStr) => {
    const startDate = new Date(startDateStr);
    const now = new Date(date);
    const diffMs = now.getTime() - startDate.getTime();
    const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
    const week = Math.floor(diffDays / 7) + 1;
    return week > 0 ? week : 1;
  };
  
  // 获取当前周（与主系统一致）
  const getCurrentWeekNumber = () => {
    const startDateStr = config.startDate || '2026-03-02T00:00:00+08:00';
    return calculateWeek(new Date(), startDateStr);
  };

  // 计算指定周的时间范围（以当前所选学期的起始日期为基准）
  const getWeekDateRange = (weekNumber) => {
    const sid = selectedSemesterId || config.currentSemesterId;
    const semester = Array.isArray(config.semesters)
      ? config.semesters.find(s => String(s.id) === String(sid))
      : null;
    const startDateStr = semester?.startDate || config.startDate || '2026-03-02T00:00:00+08:00';
    const startDate = new Date(startDateStr);
    const weekStart = new Date(startDate);
    weekStart.setDate(weekStart.getDate() + (weekNumber - 1) * 7);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    const formatDate = (date) => {
      const month = date.getMonth() + 1;
      const day = date.getDate();
      return `${month}月${day}日`;
    };
    return `${formatDate(weekStart)}~${formatDate(weekEnd)}`;
  };

  const fetchAvailableScoringWeeks = async () => {
    try {
      const res = await axios.get(getFullApiUrl('/api/available-scoring-weeks'));
      setAvailableScoringWeeks(Array.isArray(res.data.availableWeeks) ? res.data.availableWeeks : []);
      // 默认为当前周
      if (!configInitialized && typeof res.data.currentWeek === 'number') {
        setSelectedWeek(res.data.currentWeek);
      }
    } catch (err) {
      console.error('Failed to fetch available scoring weeks', err);
      setAvailableScoringWeeks([]);
    }
  };

  // 获取所有补评周期
  const fetchMakeupPeriods = async () => {
    try {
      const res = await axios.get(getFullApiUrl('/api/makeup-periods'));
      setMakeupPeriods(Array.isArray(res.data.periods) ? res.data.periods : []);
    } catch (err) {
      console.error('Failed to fetch makeup periods', err);
      setMakeupPeriods([]);
    }
  };

  // 添加补评周期
  const addMakeupPeriod = async () => {
    if (!newMakeupEndTime) {
      showNotification('请设置补评截止时间', 'error');
      return;
    }
    try {
      const res = await axios.post(getFullApiUrl('/api/makeup-periods'), {
        week: newMakeupWeek,
        endTime: newMakeupEndTime,
        description: newMakeupDescription
      });
      setMakeupPeriods(res.data.periods);
      showNotification('补评周期添加成功', 'success');
      // 清空表单
      setNewMakeupDescription('');
      // 刷新可用评分周次
      fetchAvailableScoringWeeks();
    } catch (err) {
      showNotification(err.response?.data?.error || '添加失败', 'error');
    }
  };

  // 删除补评周期
  const deleteMakeupPeriod = async (periodId) => {
    try {
      const res = await axios.delete(getFullApiUrl(`/api/makeup-periods/${periodId}`));
      setMakeupPeriods(res.data.periods);
      showNotification('补评周期删除成功', 'success');
      // 刷新可用评分周次
      fetchAvailableScoringWeeks();
    } catch (err) {
      showNotification(err.response?.data?.error || '删除失败', 'error');
    }
  };

  const fetchConfig = async () => {
    try {
      const res = await axios.get(getFullApiUrl('/api/config'));
      // 确保 config 始终是一个对象
      const configData = res.data && typeof res.data === 'object' ? res.data : { currentWeek: 1 };
      setConfig(configData);
      if (!configInitialized && typeof configData.currentWeek === 'number') {
        setSelectedWeek(configData.currentWeek);
        setSelectedSemesterId(configData.currentSemesterId || null);
        setConfigInitialized(true);
      }
      // 获取可用评分周次
      fetchAvailableScoringWeeks();
      if (currentUser && !isPublicView) {
        fetchScoredIds(currentUser.id, selectedWeek);
      }
    } catch (err) {
      console.error('Failed to fetch config', err);
      setConfig({ currentWeek: 1 });
    }
  };

  const fetchEntropyWeights = async (semesterId) => {
    try {
      const sid = semesterId || selectedSemesterId || config.currentSemesterId;
      const res = await axios.get(getFullApiUrl('/api/entropy-weights'), {
        params: sid ? { semesterId: sid } : {}
      });
      setEntropyWeights(res.data);
    } catch (err) {
      console.error('Failed to fetch entropy weights', err);
    }
  };

  const fetchExperiences = async (memberId) => {
    if (!memberId) return;
    try {
      setLoadingExperiences(true);
      const res = await axios.get(getFullApiUrl(`/api/experiences/${memberId}`));
      setExperiences(res.data);
    } catch (err) {
      console.error('Failed to fetch experiences', err);
    } finally {
      setLoadingExperiences(false);
    }
  };
  
  const fetchUpdateNotices = async () => {
    try {
      const res = await axios.get(getFullApiUrl('/api/update-notices'));
      setUpdateNotices(res.data);
    } catch (err) {
      console.error('Failed to fetch notices', err);
    }
  };
  
  const saveUpdateNotices = async (updateNotice, downloadLink, contact) => {
    try {
      await axios.post(getFullApiUrl('/api/update-notices'), {
        updateNotice,
        downloadLink,
        contact
      });
      await fetchUpdateNotices();
      showNotification('公告更新成功！', 'success');
      setShowEditNoticeModal(false);
    } catch (err) {
      console.error('Failed to update notices', err);
      showNotification('公告更新失败', 'error');
    }
  };

  const addExperience = async (memberId, uploaderId, type, data) => {
    try {
      await axios.post(getFullApiUrl('/api/experiences'), {
        memberId,
        uploaderId,
        type,
        data
      });
      await fetchExperiences(memberId);
      showNotification('添加成功！', 'success');
      // 重置表单
      setExperienceForm({
        activityName: '',
        activityAward: '',
        competitionName: '',
        competitionLevel: 'school',
        competitionAward: '',
        researchName: '',
        researchHasAdvisor: false,
        honorContent: '',
        honorTime: ''
      });
    } catch (err) {
      console.error('Failed to add experience', err);
      showNotification('添加失败', 'error');
    }
  };

  const deleteExperience = async (experienceId, memberId) => {
    try {
      await axios.delete(getFullApiUrl(`/api/experiences/${experienceId}`), {
        data: { uploaderId: currentUser?.id }
      });
      await fetchExperiences(memberId);
      showNotification('删除成功！', 'success');
    } catch (err) {
      console.error('Failed to delete experience', err);
      showNotification(err.response?.data?.error || '删除失败', 'error');
    }
  };

  useEffect(() => {
    if (currentUser && !isPublicView) {
      fetchScoredIds(currentUser.id, selectedWeek);
    }
  }, [selectedWeek, currentUser, isPublicView, targetMember?.id]);

  useEffect(() => {
    if (targetMember && view === 'score') {
      fetchTargetMemberDuties(targetMember.id);
    }
  }, [targetMember, view]);

  // 监听 view 变化，当进入评分页面时显示辅助填写介绍弹窗（仅第一次）
  useEffect(() => {
    if (view === 'score') {
      const hasSeenAssistIntro = localStorage.getItem('hasSeenAssistIntro');
      if (!hasSeenAssistIntro) {
        setShowAssistIntroModal(true);
      }
      // 加载心情标签
      fetchMoodTags();
      // 重置关系提名和心情标签
      setPositiveNominations([]);
      setNegativeNominations([]);
      setSelectedMoodTag(null);
    }
  }, [view]);

  useEffect(() => {
    if (showFilePreview) {
      // 重置PDF状态
      resetPdfState();
      if (showFilePreview.mimetype === 'application/pdf') {
        setPdfLoading(true);
      }
      if (showFilePreview.tempFileName) {
        if (showFilePreview.mimetype?.startsWith('text/') || 
            ['application/json', 'application/javascript'].includes(showFilePreview.mimetype)) {
          loadTextFileContent(showFilePreview.tempFileName);
        }
      }
    } else {
      // 关闭预览时重置PDF状态
      resetPdfState();
    }
  }, [showFilePreview, resetPdfState]);

  // 监听评分细则PDF预览状态变化
  useEffect(() => {
    if (showPdfPreview) {
      resetGuidePdfState();
      setGuidePdfLoading(true);
    } else {
      resetGuidePdfState();
    }
  }, [showPdfPreview, resetGuidePdfState]);

  // 监听公差弹窗状态变化，打开时刷新数据
  useEffect(() => {
    if (showDutyModal) {
      Promise.all([fetchDuties(), fetchDutyStats()]);
    }
  }, [showDutyModal]);
  
  // 注意事项弹窗倒计时
  useEffect(() => {
    if (showDisclaimerModal && countdownSeconds > 0) {
      const timer = setInterval(() => {
        setCountdownSeconds(prev => {
          if (prev <= 1) {
            clearInterval(timer);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      
      return () => clearInterval(timer);
    }
  }, [showDisclaimerModal, countdownSeconds]);

  const fetchMembers = async () => {
    try {
      const res = await axios.get(getFullApiUrl('/api/members'));
      setMembers(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error('Failed to fetch members', err);
      setMembers([]);
    }
  };

  // 获取班级列表
  const fetchClassList = async () => {
    try {
      const res = await axios.get(getFullApiUrl('/api/admin/classes'));
      setClassList(Array.isArray(res.data.classes) ? res.data.classes : []);
    } catch (err) {
      console.error('Failed to fetch class list', err);
      setClassList([]);
    }
  };

  // 获取班级成员
  const fetchClassMembers = async (className) => {
    setLoadingClassMembers(true);
    try {
      const res = await axios.get(getFullApiUrl('/api/admin/class-members'), {
        params: { className }
      });
      setClassMembers(Array.isArray(res.data.members) ? res.data.members : []);
    } catch (err) {
      console.error('Failed to fetch class members', err);
      setClassMembers([]);
    } finally {
      setLoadingClassMembers(false);
    }
  };

  // 修改班长
  const handleSetMonitor = async () => {
    if (!selectedClassForManagement || !selectedNewMonitor) {
      showNotification('请选择班级和新班长', 'error');
      return;
    }
    
    if (!classManagementPassword) {
      showNotification('请输入管理密码', 'error');
      return;
    }
    
    try {
      const res = await axios.post(getFullApiUrl('/api/admin/set-monitor'), {
        className: selectedClassForManagement.name,
        newMonitorId: selectedNewMonitor.id,
        password: classManagementPassword
      });
      
      if (res.data.success) {
        showNotification(`班长已修改为${res.data.newMonitor.name}，班级名称已更新为${res.data.newClassName}`, 'success');
        
        // 刷新数据
        await fetchClassList();
        await fetchMembers();
        
        // 关闭弹窗并重置状态
        setShowClassManagementModal(false);
        setSelectedClassForManagement(null);
        setClassMembers([]);
        setSelectedNewMonitor(null);
        setClassManagementPassword('');
      }
    } catch (err) {
      console.error('Failed to set monitor', err);
      showNotification(err.response?.data?.error || '修改班长失败', 'error');
    }
  };

  const fetchAllFitnessScores = async (semesterId) => {
    try {
      const sid = semesterId || selectedSemesterId;
      const res = await axios.get(getFullApiUrl('/api/fitness-scores'), {
        params: sid ? { semesterId: sid } : {}
      });
      setAllFitnessScores(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error('Failed to fetch fitness scores', err);
      setAllFitnessScores([]);
    }
  };

  const fetchAllRankScores = async (semesterId) => {
    try {
      const sid = semesterId || selectedSemesterId;
      const res = await axios.get(getFullApiUrl('/api/rank-scores'), {
        params: sid ? { semesterId: sid } : {}
      });
      setAllRankScores(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error('Failed to fetch rank scores', err);
      setAllRankScores([]);
    }
  };

  const fetchLastWeekSubScores = async (memberId) => {
    try {
      // 使用新API获取当前评分人对该成员的详细评分
      const res = await axios.get(getFullApiUrl(`/api/evaluator/${currentUser.id}/member/${memberId}/last-week-scores`));
      setLastWeekSubScores(res.data);
      return res.data;
    } catch (err) {
      console.error('Failed to fetch last week sub scores', err);
      setLastWeekSubScores(null);
      return null;
    }
  };

  // 获取成员上周的聚合评分数据（用于个人信息六大板块显示）
  const fetchMemberLastWeekSubScores = async (memberId) => {
    try {
      const res = await axios.get(getFullApiUrl(`/api/member/${memberId}/last-week-sub-scores`));
      setLastWeekSubScores(res.data);
      return res.data;
    } catch (err) {
      console.error('Failed to fetch member last week sub scores', err);
      setLastWeekSubScores(null);
      return null;
    }
  };

  // 获取连续两周评分数据（用于检测连续相似）
  const fetchConsecutiveWeeksScores = async (memberId) => {
    try {
      const res = await axios.get(getFullApiUrl(`/api/evaluator/${currentUser.id}/member/${memberId}/consecutive-scores`));
      setConsecutiveWeeksScores(res.data);
      return res.data;
    } catch (err) {
      console.error('Failed to fetch consecutive weeks scores', err);
      setConsecutiveWeeksScores(null);
      return null;
    }
  };

  // 应用上周评分到当前表单
  const applyLastWeekScores = () => {
    if (lastWeekSubScores && lastWeekSubScores.subItemScores) {
      setSubItemScores({ ...lastWeekSubScores.subItemScores });
      showNotification('已自动填充上周评分！', 'success');
      // 检测异常评分
      detectScoreAnomalies(lastWeekSubScores.subItemScores);
    }
  };

  // 检测评分异常
  const detectScoreAnomalies = (currentScores) => {
    const warnings = [];
    const allKeys = Object.keys(currentScores);
    
    // 1. 检测所有分数完全相同（仅作为中度提醒，不拦截）
    if (lastWeekSubScores && lastWeekSubScores.subItemScores) {
      const lastScores = lastWeekSubScores.subItemScores;
      const allSame = allKeys.length > 0 && allKeys.every(key => currentScores[key] === lastScores[key]);
      if (allSame) {
        warnings.push({
          code: 'IDENTICAL_SCORES',
          type: 'warning',
          message: '所有评分与上周完全相同，这是中度提醒',
          severity: 'medium'
        });
      }
    }
    
    // 2. 检测连续两周评分完全相同（拦截）
    if (consecutiveWeeksScores && consecutiveWeeksScores.scores && consecutiveWeeksScores.scores.length >= 2) {
      const [latestWeek, previousWeek] = consecutiveWeeksScores.scores;
      const latestKeys = Object.keys(latestWeek.subItemScores);
      const allConsecutiveSame = latestKeys.length > 0 && latestKeys.every(key => {
        return currentScores[key] === latestWeek.subItemScores[key] && 
               latestWeek.subItemScores[key] === previousWeek.subItemScores[key];
      });
      
      if (allConsecutiveSame) {
        warnings.push({
          code: 'CONSECUTIVE_IDENTICAL',
          type: 'warning',
          message: `连续两周评分完全相同（第${previousWeek.week}周和第${latestWeek.week}周），请确认本周是否有实际变化`,
          severity: 'high'
        });
      }
    }
    
    // 3. 检测剧烈波动（变化超过±2分）
    if (lastWeekSubScores && lastWeekSubScores.subItemScores) {
      const lastScores = lastWeekSubScores.subItemScores;
      allKeys.forEach(key => {
        const current = currentScores[key];
        const last = lastScores[key];
        if (last !== undefined && last !== null) {
          const diff = Math.abs(current - last);
          if (diff >= 2) {
            // 找出对应的维度和子项名称
            const [dimKey, subKey] = key.split('_');
            const dim = dimensions.find(d => d.key === dimKey);
            const subItem = dim?.subItems.find(s => s.key === subKey);
            const label = subItem?.label || key;
            
            warnings.push({
              code: 'LARGE_FLUCTUATION',
              type: 'info',
              message: `${label} 评分变化较大（${last} → ${current}）`,
              severity: 'low'
            });
          }
        }
      });
    }
    
    // 4. 检测极端值（全部是最高分或全部是最低分）- 始终检测
    let allMax = true;
    let allMin = true;
    
    dimensions.forEach(dim => {
      dim.subItems.forEach(subItem => {
        const key = `${dim.key}_${subItem.key}`;
        const score = currentScores[key];
        if (score !== subItem.maxScore) allMax = false;
        if (score !== subItem.minScore) allMin = false;
      });
    });
    
    if (allMax) {
      warnings.push({
        code: 'ALL_MAX',
        type: 'warning',
        message: '所有评分都是最高分，请确认评分是否合理',
        severity: 'high'
      });
    }
    
    if (allMin) {
      warnings.push({
        code: 'ALL_MIN',
        type: 'warning',
        message: '所有评分都是最低分，请确认评分是否合理',
        severity: 'high'
      });
    }
    
    setScoreWarnings(warnings);
    return warnings;
  };

  // BMI数据相关函数
  const fetchBMIWeeks = async (semesterId) => {
    try {
      const sid = semesterId || selectedSemesterId;
      const res = await axios.get(getFullApiUrl('/api/bmi/weeks'), {
        params: sid ? { semesterId: sid } : {}
      });
      setBmiWeeks(res.data.weeks);
    } catch (err) {
      console.error('Failed to fetch BMI weeks', err);
    }
  };

  const fetchAllBMIData = async (semesterId) => {
    try {
      const sid = semesterId || selectedSemesterId;
      const res = await axios.get(getFullApiUrl('/api/bmi/all'), {
        params: sid ? { semesterId: sid } : {}
      });
      setAllBMIData(res.data.data || []);
    } catch (err) {
      console.error('Failed to fetch all BMI data', err);
    }
  };

  // BMI数据缓存相关
  const BMI_CACHE_KEY = 'class_scoring_bmi_cache';
  
  // 周总结相关函数
  const fetchAvailableWeeks = async (semesterId) => {
    try {
      const sid = semesterId || selectedSemesterId;
      const res = await axios.get(getFullApiUrl('/api/summary/available-weeks'), {
        params: sid ? { semesterId: sid } : {}
      });
      setAvailableWeeks(res.data.weeks || []);
    } catch (err) {
      console.error('Failed to fetch available weeks', err);
    }
  };

  const fetchWeekSummary = async (week, semesterId) => {
    if (!week) return;
    try {
      setLoadingWeekSummary(true);
      const sid = semesterId || selectedSemesterId;
      const res = await axios.get(getFullApiUrl(`/api/summary/${week}`), {
        params: sid ? { semesterId: sid } : {}
      });
      setWeekSummaryData(res.data);
    } catch (err) {
      console.error('Failed to fetch week summary', err);
      showNotification('获取周总结数据失败', 'error');
    } finally {
      setLoadingWeekSummary(false);
    }
  };
  
  // ========== 心理气象站相关函数 ==========
  
  const fetchAlerts = async (week) => {
    try {
      setLoadingPsychologicalData(true);
      const params = week ? { week } : {};
      const res = await axios.get(getFullApiUrl('/api/psychological-station/alerts'), { params });
      setAlertData(res.data);
    } catch (err) {
      console.error('Failed to fetch alerts', err);
      showNotification('获取预警数据失败', 'error');
    } finally {
      setLoadingPsychologicalData(false);
    }
  };
  
  const fetchSocialMap = async (week, className) => {
    try {
      setLoadingPsychologicalData(true);
      const params = {};
      if (week) params.week = week;
      if (className) params.className = className;
      const res = await axios.get(getFullApiUrl('/api/psychological-station/social-map'), { params });
      setSocialMapData(res.data);
    } catch (err) {
      console.error('Failed to fetch social map', err);
      showNotification('获取社交地图失败', 'error');
    } finally {
      setLoadingPsychologicalData(false);
    }
  };
  
  const fetchCompatibility = async (memberAId, memberBId) => {
    try {
      setIsCompatibilityLoading(true);
      setCompatibilityReport('');
      setCompatibilityError(null);
      
      const response = await fetch(getFullApiUrl('/api/psychological-station/compatibility/stream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberAId, memberBId })
      });

      if (!response.ok) throw new Error('请求失败');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let result = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const lines = text.split('\n').filter(line => line.trim() !== '');
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'content') {
                result += data.content;
                setCompatibilityReport(result);
                if (compatibilityAutoScroll.current && compatibilityRef.current) {
                  compatibilityRef.current.scrollTop = compatibilityRef.current.scrollHeight;
                }
              } else if (data.type === 'error') {
                setCompatibilityError(data.content || '分析出错');
              }
            } catch (e) {}
          }
        }
      }

      if (!result && !compatibilityError) {
        setCompatibilityError('未获取到分析结果');
      }
    } catch (err) {
      console.error('Failed to fetch compatibility', err);
      setCompatibilityError(err.message || '获取相容性分析失败');
      showNotification('获取相容性分析失败', 'error');
    } finally {
      setIsCompatibilityLoading(false);
    }
  };
  
  const fetchWeeklyReport = async () => {
    try {
      setLoadingPsychologicalData(true);
      const res = await axios.get(getFullApiUrl('/api/psychological-station/weekly-report'));
      setWeeklyReportData(res.data);
    } catch (err) {
      console.error('Failed to fetch weekly report', err);
      showNotification('获取工作简报失败', 'error');
    } finally {
      setLoadingPsychologicalData(false);
    }
  };

  // 生成心理咨询报告（流式输出）
  const generateCounselingReport = async () => {
    if (!counselingMemberId) return;

    try {
      setIsCounselingLoading(true);
      setCounselingReport('');
      setCounselingError(null);
      setFollowUpQuestion('');
      setFollowUpError(null);
      counselingAutoScroll.current = true;
      let fullPrompt = '';
      let fullResponse = '';

      const response = await fetch(getFullApiUrl('/api/psychological-counseling'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          memberId: counselingMemberId,
          additionalNotes: counselingNotes || undefined
        })
      });

      if (!response.ok) {
        throw new Error('请求失败');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'content') {
                fullResponse += data.content;
                setCounselingReport(prev => prev + data.content);
                if (counselingAutoScroll.current && counselingRef.current) {
                  counselingRef.current.scrollTop = counselingRef.current.scrollHeight;
                }
              } else if (data.type === 'error') {
                setCounselingError(data.content);
                setIsCounselingLoading(false);
              } else if (data.type === 'done') {
                setIsCounselingLoading(false);
                // 保存对话历史
                setCounselingPrompt(fullPrompt);
                setConversationHistory([
                  { role: 'user', content: fullPrompt },
                  { role: 'assistant', content: fullResponse }
                ]);
              }
            } catch (e) {
              // 忽略解析错误
            }
          }
        }
      }
    } catch (err) {
      console.error('Counseling error:', err);
      setCounselingError(err.message || '生成报告失败，请重试');
      setIsCounselingLoading(false);
    }
  };

  // 发送追加提问
  const sendFollowUpQuestion = async () => {
    if (!followUpQuestion.trim() || !counselingMemberId) return;

    try {
      setIsFollowUpLoading(true);
      setFollowUpError(null);
      
      // 追加用户问题到报告显示
      const userQuestion = `\n\n---\n\n**👤 您的提问：** ${followUpQuestion}\n\n**💬 AI 回复：**`;
      setCounselingReport(prev => prev + userQuestion);

      const newHistory = [
        ...conversationHistory,
        { role: 'user', content: followUpQuestion }
      ];

      const response = await fetch(getFullApiUrl('/api/psychological-counseling/followup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memberId: counselingMemberId,
          question: followUpQuestion,
          conversationHistory: newHistory
        })
      });

      if (!response.ok) throw new Error('请求失败');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let aiResponse = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'content') {
                aiResponse += data.content;
                setCounselingReport(prev => prev + data.content);
                if (followUpRef.current) {
                  followUpRef.current.scrollTop = followUpRef.current.scrollHeight;
                }
              } else if (data.type === 'error') {
                setFollowUpError(data.content);
              } else if (data.type === 'done') {
                // 更新对话历史
                setConversationHistory([
                  ...newHistory,
                  { role: 'assistant', content: aiResponse }
                ]);
              }
            } catch (e) {}
          }
        }
      }

      setFollowUpQuestion('');
    } catch (err) {
      console.error('Follow-up error:', err);
      setFollowUpError(err.message || '提问失败，请重试');
    } finally {
      setIsFollowUpLoading(false);
    }
  };

  // 简单的Markdown渲染函数
  const formatMarkdown = (text) => {
    if (!text) return '';
    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/^### (.*$)/gm, '<h3 class="text-lg font-bold text-gray-800 mt-4 mb-2">$1</h3>')
      .replace(/^## (.*$)/gm, '<h2 class="text-xl font-bold text-gray-900 mt-6 mb-3">$1</h2>')
      .replace(/^# (.*$)/gm, '<h1 class="text-2xl font-bold text-gray-900 mt-6 mb-4">$1</h1>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/^- (.*$)/gm, '<li class="ml-4 list-disc">$1</li>')
      .replace(/(\n<li.*<\/li>)/g, '$1')
      .replace(/\n\n/g, '</p><p class="mb-3">')
      .replace(/\n/g, '<br/>');
    return `<p class="mb-3">${html}</p>`;
  };
  
  // ========== 社交地图分析函数 ==========
  
  // 检测孤岛节点
  const detectIslands = useCallback(() => {
    if (!socialMapData) return;
    
    const { nodes, edges } = socialMapData;
    const nodeConnections = new Map();
    
    // 初始化每个节点的连接数
    nodes.forEach(node => {
      nodeConnections.set(node.id, { in: 0, out: 0, mutual: 0 });
    });
    
    // 统计连接
    edges.forEach(edge => {
      const sourceStats = nodeConnections.get(edge.source);
      const targetStats = nodeConnections.get(edge.target);
      
      if (sourceStats) sourceStats.out++;
      if (targetStats) targetStats.in++;
      
      if (edge.type === 'mutual-positive') {
        if (sourceStats) sourceStats.mutual++;
        if (targetStats) targetStats.mutual++;
      }
    });
    
    // 识别孤岛：没有任何连接或只有单向连接
    const islands = nodes.filter(node => {
      const stats = nodeConnections.get(node.id);
      if (!stats) return true;
      return stats.mutual === 0 && stats.in + stats.out <= 1;
    });
    
    setDetectedIslands(islands);
  }, [socialMapData]);
  
  // 小团体识别（基于简单的社区发现算法）
  const detectGroups = useCallback(() => {
    if (!socialMapData) return;
    
    const { nodes, edges } = socialMapData;
    const groups = [];
    const visited = new Set();
    
    // 使用连通分量识别基础社区
    const buildGraph = () => {
      const graph = new Map();
      nodes.forEach(node => graph.set(node.id, []));
      
      edges.forEach(edge => {
        if (edge.type === 'mutual-positive' || edge.type === 'one-way-positive') {
          graph.get(edge.source)?.push(edge.target);
          graph.get(edge.target)?.push(edge.source);
        }
      });
      
      return graph;
    };
    
    const graph = buildGraph();
    
    // BFS查找连通分量
    nodes.forEach(node => {
      if (!visited.has(node.id)) {
        const queue = [node.id];
        visited.add(node.id);
        const group = [];
        
        while (queue.length > 0) {
          const current = queue.shift();
          group.push(current);
          
          graph.get(current)?.forEach(neighbor => {
            if (!visited.has(neighbor)) {
              visited.add(neighbor);
              queue.push(neighbor);
            }
          });
        }
        
        if (group.length >= 3) { // 至少3人才能算小团体
          groups.push({
            id: groups.length,
            memberIds: group,
            members: nodes.filter(n => group.includes(n.id))
          });
        }
      }
    });
    
    setDetectedGroups(groups);
  }, [socialMapData]);
  
  // 生成ECharts配置
  const getSocialMapChartOption = useCallback(() => {
    if (!socialMapData) return {};
    
    const { nodes, edges } = socialMapData;
    
    // 转换节点为地图，用于快速查找
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const islandIds = new Set(detectedIslands.map(i => i.id));
    const groupMemberMap = new Map();
    
    // 构建群体成员映射
    if (mapToolMode === 'group' || mapToolMode === 'bridge') {
      detectedGroups.forEach(group => {
        group.memberIds.forEach(memberId => {
          groupMemberMap.set(memberId, group);
        });
      });
    }
    
    // 转换为ECharts格式
    const echartsNodes = nodes.map(node => {
      const isExtrovert = node.type === 'extrovert';
      const isRedCode = node.alertLevel === 'red';
      const isIsland = islandIds.has(node.id);
      const isInGroup = groupMemberMap.has(node.id);
      const isBridge = recommendedBridges.some(b => b.node.id === node.id);
      const totalScore = node.totalScore || 0;
      
      let itemStyle = {};
      let symbolSize = node.size;
      let opacity = 1;
      
      // 首先设置节点基础颜色（根据总分，在所有模式下都生效）
      if (isExtrovert) {
        if (totalScore > 0) {
          itemStyle.color = '#2563eb'; // 深蓝色（外向型正向）
        } else if (totalScore < 0) {
          itemStyle.color = '#1d4ed8'; // 更深的蓝色（外向型负向）
        } else {
          itemStyle.color = '#3b82f6'; // 基础蓝色（外向型零分）
        }
      } else {
        if (totalScore > 0) {
          itemStyle.color = '#16a34a'; // 深绿色（内向型正向）
        } else if (totalScore < 0) {
          itemStyle.color = '#15803d'; // 更深的绿色（内向型负向）
        } else {
          itemStyle.color = '#22c55e'; // 基础绿色（内向型零分）
        }
      }
      
      // 根据工具模式调整显示
      if (mapToolMode === 'view') {
        // 查看模式：添加总分光晕特效
        if (totalScore > 0) {
          // 正向总分：金色光晕特效
          symbolSize = node.size * (1 + Math.min(totalScore * 0.1, 0.5));
          itemStyle.borderColor = '#fbbf24';
          itemStyle.borderWidth = 3;
          itemStyle.shadowBlur = 15 + Math.min(totalScore * 3, 20);
          itemStyle.shadowColor = '#fbbf24';
        } else if (totalScore < 0) {
          // 负向总分：紫色光晕特效
          symbolSize = node.size * (1 + Math.min(Math.abs(totalScore) * 0.1, 0.5));
          itemStyle.borderColor = '#a855f7';
          itemStyle.borderWidth = 3;
          itemStyle.shadowBlur = 15 + Math.min(Math.abs(totalScore) * 3, 20);
          itemStyle.shadowColor = '#a855f7';
        } else {
          // 零分：微弱灰色光晕
          itemStyle.borderColor = '#9ca3af';
          itemStyle.borderWidth = 1;
          itemStyle.shadowBlur = 5;
          itemStyle.shadowColor = '#9ca3af';
        }
        
        // 红码闪烁效果（覆盖总分的光晕）
        if (isRedCode) {
          itemStyle.shadowBlur = 25;
          itemStyle.shadowColor = '#ef4444';
          itemStyle.borderColor = '#ef4444';
          itemStyle.borderWidth = 4;
        }
      } else if (mapToolMode === 'focus-island') {
        if (isIsland) {
          // 孤岛节点：高亮放大
          symbolSize = node.size * 1.8;
          itemStyle.borderColor = '#f97316';
          itemStyle.borderWidth = 4;
          itemStyle.shadowBlur = 15;
          itemStyle.shadowColor = '#f97316';
        } else {
          // 非孤岛节点：缩小变暗
          symbolSize = node.size * 0.6;
          opacity = 0.4;
        }
      } else if (mapToolMode === 'group') {
        if (isInGroup) {
          // 群体内节点：高亮
          const group = groupMemberMap.get(node.id);
          itemStyle.borderColor = '#22c55e';
          itemStyle.borderWidth = 3;
          itemStyle.shadowBlur = 10;
          itemStyle.shadowColor = '#22c55e';
        } else {
          // 非群体节点：缩小变暗
          symbolSize = node.size * 0.5;
          opacity = 0.3;
        }
      } else if (mapToolMode === 'bridge') {
        // 检查节点是否在选中的小团体内
        const isInSelectedGroup = selectedBridgeGroups.some(g => g.memberIds.includes(node.id));
        
        if (isBridge) {
          // 桥梁人：高亮放大（紫色）
          symbolSize = node.size * 2;
          itemStyle.borderColor = '#a855f7';
          itemStyle.borderWidth = 5;
          itemStyle.shadowBlur = 25;
          itemStyle.shadowColor = '#a855f7';
        } else if (isInSelectedGroup && selectedBridgeGroups.length === 2) {
          // 选中小团体内的节点：用不同颜色标记
          const group = selectedBridgeGroups.find(g => g.memberIds.includes(node.id));
          if (group) {
            const groupIndex = selectedBridgeGroups.indexOf(group);
            itemStyle.borderColor = groupIndex === 0 ? '#3b82f6' : '#ef4444';
            itemStyle.borderWidth = 4;
            itemStyle.shadowBlur = 12;
            itemStyle.shadowColor = groupIndex === 0 ? '#3b82f6' : '#ef4444';
            symbolSize = node.size * 1.2;
          }
        } else if (selectedBridgeGroups.length === 2) {
          // 不在选中小团体内的节点：缩小变暗
          symbolSize = node.size * 0.5;
          opacity = 0.2;
        } else {
          // 没有选中小团体时的默认行为
          if (!isBridge) {
            symbolSize = node.size * 0.6;
            opacity = 0.4;
          }
        }
      }
      
      itemStyle.opacity = opacity;
      
      // 节点标签显示分数
      let labelFormatter = '{b}';
      if (isIsland) {
        labelFormatter = `{b} ⚠️`;
      } else if (isBridge) {
        labelFormatter = `{b} 🌉`;
      } else {
        if (totalScore > 0) {
          labelFormatter = `{b} +${totalScore}`;
        } else if (totalScore < 0) {
          labelFormatter = `{b} ${totalScore}`;
        }
      }
      
      return {
        id: node.id,
        name: node.name,
        value: node.positiveCount,
        symbolSize,
        category: isExtrovert ? 0 : 1,
        itemStyle,
        label: {
          show: true,
          formatter: labelFormatter,
          fontSize: isIsland || isBridge ? 12 : 10,
          fontWeight: isIsland || isBridge ? 'bold' : 'normal'
        }
      };
    });
    
    // 根据工具模式过滤和调整连线
    let displayEdges = edges;
    
    if (mapToolMode === 'focus-island') {
      displayEdges = edges.filter(edge => islandIds.has(edge.source) || islandIds.has(edge.target));
    } else if (mapToolMode === 'bridge') {
      const bridgeIds = new Set(recommendedBridges.map(b => b.node.id));
      displayEdges = edges.filter(edge => bridgeIds.has(edge.source) || bridgeIds.has(edge.target));
    }
    
    const echartsLinks = displayEdges.map(edge => {
      let lineStyle = {};
      let label = {};
      
      switch (edge.type) {
        case 'mutual-positive':
          lineStyle = { color: '#22c55e', width: 4, type: 'solid', curveness: 0 };
          label = { show: false };
          break;
        case 'one-way-positive':
          lineStyle = { color: '#3b82f6', width: 2, type: 'solid', curveness: 0.15 };
          label = { show: false };
          break;
        case 'negative':
          lineStyle = { color: '#ef4444', width: 3, type: 'dotted', curveness: 0.5 };
          label = { show: false };
          break;
      }
      
      if (mapToolMode !== 'view') {
        lineStyle.opacity = 0.6;
      }
      
      return {
        source: edge.source,
        target: edge.target,
        lineStyle,
        label
      };
    });
    
    let forceConfig = {
      repulsion: 500,
      edgeLength: 120,
      gravity: 0.08,
      layoutAnimation: true
    };
    
    if (mapToolMode === 'focus-island') {
      forceConfig.repulsion = 700;
      forceConfig.gravity = 0.04;
    } else if (mapToolMode === 'group') {
      forceConfig.edgeLength = 70;
      forceConfig.gravity = 0.25;
      forceConfig.repulsion = 300;
    } else if (mapToolMode === 'bridge') {
      forceConfig.repulsion = 350;
      forceConfig.edgeLength = 100;
    }
    
    return {
      tooltip: {
        formatter: (params) => {
          if (params.dataType === 'node') {
            const node = nodeMap.get(params.data.id);
            const totalScore = node?.totalScore || 0;
            return `<strong>${params.data.name}</strong><br/>
                    MBTI: ${node?.mbti || '未知'}<br/>
                    正向提名: ${node?.positiveCount || 0}<br/>
                    反向提名: ${node?.negativeCount || 0}<br/>
                    总分: ${totalScore > 0 ? '+' + totalScore : totalScore}<br/>
                    预警等级: ${node?.alertLevel === 'red' ? '🔴红码' : node?.alertLevel === 'yellow' ? '🟡黄码' : '🟢绿码'}`;
          } else if (params.dataType === 'edge') {
            const edge = edges.find(e => e.source === params.data.source && e.target === params.data.target);
            if (!edge) return '';
            
            const typeLabels = {
              'mutual-positive': '🤝 双向正向',
              'one-way-positive': '👍 单向正向',
              'negative': '👎 反向提名'
            };
            
            let tooltipHtml = `<strong>${typeLabels[edge.type] || '关系'}</strong><br/>`;
            if (edge.evaluatorName && edge.targetName) {
              tooltipHtml += `${edge.evaluatorName} → ${edge.targetName}`;
            }
            return tooltipHtml;
          }
        }
      },
      legend: [{ data: ['外向型', '内向型'] }],
      series: [{
        type: 'graph',
        layout: 'force',
        data: echartsNodes,
        links: echartsLinks,
        categories: [{ name: '外向型' }, { name: '内向型' }],
        roam: true,
        label: { position: 'right', formatter: '{b}' },
        lineStyle: { color: 'source', curveness: 0.3 },
        force: forceConfig,
        emphasis: {
          focus: 'adjacency',
          lineStyle: { width: mapToolMode === 'view' ? 5 : 3 }
        }
      }]
    };
  }, [socialMapData, detectedIslands, detectedGroups, mapToolMode, recommendedBridges, selectedBridgeGroups]);
  
  // 处理节点点击
  const handleMapNodeClick = useCallback((params) => {
    if (params.dataType === 'node') {
      setSelectedMapMemberId(params.data.id);
      
      // 如果是孤岛模式，选中孤岛时生成干预建议
      if (mapToolMode === 'focus-island' && detectedIslands.some(i => i.id === params.data.id)) {
        generateInterventionSuggestion(params.data.id);
      }
    }
  }, [mapToolMode, detectedIslands]);
  
  // 生成干预建议（AI调用）
  const generateInterventionSuggestion = async (islandNodeId) => {
    if (!socialMapData) return;
    
    const islandNode = socialMapData.nodes.find(n => n.id === islandNodeId);
    if (!islandNode) return;
    
    // 找到最近的暖色大节点（外向型且正向提名多）
    const warmNodes = socialMapData.nodes
      .filter(n => n.type === 'extrovert' && n.positiveCount >= 3 && n.id !== islandNodeId)
      .sort((a, b) => b.positiveCount - a.positiveCount);
    
    const nearestWarmNode = warmNodes[0];
    
    if (nearestWarmNode) {
      setInterventionSuggestion({
        islandNode,
        nearestWarmNode,
        suggestion: `建议通过 ${nearestWarmNode.name}（${nearestWarmNode.mbti || '未知'}）作为桥梁，帮助 ${islandNode.name}（${islandNode.mbti || '未知'}）融入集体。可以先安排他们共同参与一些低压力的小组活动。`
      });
    }
  };
  
  // 计算最佳桥梁人
  const calculateBridgePersons = useCallback(() => {
    if (!socialMapData) return;
    
    const bridges = [];
    const { nodes, edges } = socialMapData;
    
    // 如果选中了两个小团体，只计算这两个团体之间的桥梁人
    if (selectedBridgeGroups.length === 2) {
      const [groupA, groupB] = selectedBridgeGroups;
      const groupAMemberIds = new Set(groupA.memberIds);
      const groupBMemberIds = new Set(groupB.memberIds);
      
      // 检查连接两个团体的节点
      nodes.forEach(node => {
        // 只考虑在两个团体之一的节点
        if (!groupAMemberIds.has(node.id) && !groupBMemberIds.has(node.id)) return;
        
        let crossGroupConnections = 0;
        let totalConnections = 0;
        
        edges.forEach(edge => {
          if (edge.source === node.id || edge.target === node.id) {
            totalConnections++;
            
            // 检查是否连接到另一个团体
            const otherNodeId = edge.source === node.id ? edge.target : edge.source;
            const isInGroupA = groupAMemberIds.has(node.id);
            const otherIsInTargetGroup = isInGroupA ? groupBMemberIds.has(otherNodeId) : groupAMemberIds.has(otherNodeId);
            
            if (otherIsInTargetGroup) {
              crossGroupConnections++;
            }
          }
        });
        
        // 度数适中且跨群体连接多的节点
        if (totalConnections >= 2 && totalConnections <= 10 && crossGroupConnections >= 1) {
          bridges.push({
            node,
            totalConnections,
            crossGroupConnections,
            betweenGroups: [groupA, groupB],
            score: crossGroupConnections / totalConnections
          });
        }
      });
    } else {
      // 原有逻辑：计算所有群体的桥梁人
      if (detectedGroups.length < 2) return;
      
      nodes.forEach(node => {
        let crossGroupConnections = 0;
        let totalConnections = 0;
        
        edges.forEach(edge => {
          if (edge.source === node.id || edge.target === node.id) {
            totalConnections++;
            
            // 检查是否跨群体
            const otherNodeId = edge.source === node.id ? edge.target : edge.source;
            const nodeGroup = detectedGroups.find(g => g.memberIds.includes(node.id));
            const otherGroup = detectedGroups.find(g => g.memberIds.includes(otherNodeId));
            
            if (nodeGroup && otherGroup && nodeGroup.id !== otherGroup.id) {
              crossGroupConnections++;
            }
          }
        });
        
        // 度数适中且跨群体连接多的节点
        if (totalConnections >= 2 && totalConnections <= 8 && crossGroupConnections >= 2) {
          bridges.push({
            node,
            totalConnections,
            crossGroupConnections,
            score: crossGroupConnections / totalConnections
          });
        }
      });
    }
    
    // 按跨群体比例排序
    bridges.sort((a, b) => b.score - a.score);
    setRecommendedBridges(bridges.slice(0, 3));
  }, [socialMapData, detectedGroups, selectedBridgeGroups]);
  
  // 社交地图数据加载时自动运行检测
  useEffect(() => {
    if (socialMapData && psychologicalStationTab === 'social-map') {
      detectIslands();
      detectGroups();
    }
  }, [socialMapData, psychologicalStationTab, detectIslands, detectGroups]);
  
  // 选中小团体时自动计算桥梁人
  useEffect(() => {
    if (mapToolMode === 'bridge' && selectedBridgeGroups.length > 0) {
      calculateBridgePersons();
    }
  }, [selectedBridgeGroups, mapToolMode, calculateBridgePersons]);
  
  const fetchMoodTags = async () => {
    try {
      const res = await axios.get(getFullApiUrl('/api/mood-tags'));
      setMoodTags(res.data);
    } catch (err) {
      console.error('Failed to fetch mood tags', err);
    }
  };
  
  const submitRelationshipNomination = async () => {
    if (!currentUser) return;
    try {
      await axios.post(getFullApiUrl('/api/relationship-nominations'), {
        evaluatorId: currentUser.id,
        positiveNominations,
        negativeNominations,
        moodTag: selectedMoodTag
      });
      showNotification('关系提名提交成功！');
    } catch (err) {
      console.error('Failed to submit relationship nomination', err);
      showNotification('提交关系提名失败', 'error');
    }
  };
  
  const loadBMICache = (week) => {
    if (typeof window === 'undefined' || !week) return {};
    try {
      const cacheStr = localStorage.getItem(BMI_CACHE_KEY);
      if (!cacheStr) return {};
      const cache = JSON.parse(cacheStr);
      return cache[week] || {};
    } catch (err) {
      console.error('Failed to load BMI cache:', err);
      return {};
    }
  };
  
  const saveBMICache = (week, data) => {
    if (typeof window === 'undefined' || !week) return;
    try {
      const cacheStr = localStorage.getItem(BMI_CACHE_KEY);
      let cache = {};
      if (cacheStr) {
        cache = JSON.parse(cacheStr);
      }
      cache[week] = data;
      localStorage.setItem(BMI_CACHE_KEY, JSON.stringify(cache));
    } catch (err) {
      console.error('Failed to save BMI cache:', err);
    }
  };
  
  const fetchBMIByWeek = async (week, semesterId) => {
    try {
      const sid = semesterId || selectedSemesterId;
      const res = await axios.get(getFullApiUrl(`/api/bmi/week/${week}`), {
        params: sid ? { semesterId: sid } : {}
      });
      setBmiData(res.data.data || {});
      return res.data.data || {};
    } catch (err) {
      console.error('Failed to fetch BMI data', err);
      return {};
    }
  };

  // 监听BMI模态框关闭时保存缓存
  useEffect(() => {
    if (showBMIModal) {
      // 模态框打开时不保存
      return;
    }
    // 模态框关闭时保存缓存
    if (selectedBMIWeek && Object.keys(bmiData).length > 0) {
      saveBMICache(selectedBMIWeek, bmiData);
    }
  }, [showBMIModal]);

  const saveBMIData = async () => {
    if (!selectedBMIWeek) {
      showNotification('请选择周数', 'error');
      return;
    }
    
    try {
      setSavingBMI(true);
      await axios.post(getFullApiUrl('/api/bmi/save'), {
        password: bmiPassword,
        week: selectedBMIWeek,
        semesterId: selectedSemesterId || undefined,
        data: bmiData
      });
      showNotification('BMI数据保存成功！');
      // 保存成功后清空缓存
      if (selectedBMIWeek) {
        // 从缓存中移除该周的数据
        const cacheStr = localStorage.getItem(BMI_CACHE_KEY);
        if (cacheStr) {
          const cache = JSON.parse(cacheStr);
          delete cache[selectedBMIWeek];
          localStorage.setItem(BMI_CACHE_KEY, JSON.stringify(cache));
        }
      }
    } catch (err) {
      console.error('Failed to save BMI data', err);
      showNotification(err.response?.data?.error || '保存失败', 'error');
    } finally {
      setSavingBMI(false);
    }
  };

  const calculateBMI = (height, weight) => {
    if (!height || !weight) return '';
    const h = parseFloat(height);
    const w = parseFloat(weight);
    if (isNaN(h) || isNaN(w) || h <= 0 || w <= 0) return '';
    const heightInMeters = h / 100;
    const bmi = w / (heightInMeters * heightInMeters);
    return bmi.toFixed(1);
  };

  const fetchFixedHeights = async () => {
    try {
      const res = await axios.get(getFullApiUrl('/api/bmi/fixed-heights'));
      setFixedHeights(res.data.data || {});
    } catch (err) {
      console.error('Failed to fetch fixed heights', err);
    }
  };

  const fetchStats = async (memberId, semesterId) => {
    try {
      const sid = semesterId || selectedSemesterId || config.currentSemesterId;
      const res = await axios.get(getFullApiUrl(`/api/stats/${memberId}`), {
        params: sid ? { semesterId: sid } : {}
      });
      setStats(res.data);
      await fetchMemberFiles(memberId);
    } catch (err) {
      console.error('Failed to fetch stats', err);
    }
  };
  
  const fetchAndLoadMemberScore = async (memberId, evaluatorId) => {
    if (!evaluatorId) {
      // 如果没有选择评分者，重置为默认值
      const defaultScores = {};
      dimensions.forEach(dim => {
        dim.subItems.forEach(subItem => {
          defaultScores[`${dim.key}_${subItem.key}`] = subItem.minScore;
        });
      });
      setSubItemScores(defaultScores);
      setEditScoreData(null);
      return;
    }
    
    try {
      const week = editScoreWeek || config.currentWeek;
      const sid = selectedSemesterId || config.currentSemesterId;
      const url = getFullApiUrl(`/api/scores/${memberId}/${week}?evaluatorId=${evaluatorId}${sid ? `&semesterId=${sid}` : ''}`);

      const res = await axios.get(url);
      
      if (res.data && res.data.subItemScores) {
        // 加载现有评分数据到subItemScores
        setSubItemScores(res.data.subItemScores);
        setEditScoreData(res.data);
      } else {
        // 如果没有评分数据，重置为默认值
        const defaultScores = {};
        dimensions.forEach(dim => {
          dim.subItems.forEach(subItem => {
            defaultScores[`${dim.key}_${subItem.key}`] = subItem.minScore;
          });
        });
        setSubItemScores(defaultScores);
        setEditScoreData(null);
      }
    } catch (err) {
      console.error('Failed to fetch member score', err);
      // 如果获取失败，使用默认值
      const defaultScores = {};
      dimensions.forEach(dim => {
        dim.subItems.forEach(subItem => {
          defaultScores[`${dim.key}_${subItem.key}`] = subItem.minScore;
        });
      });
      setSubItemScores(defaultScores);
      setEditScoreData(null);
    }
  };

  const fetchMemberFiles = async (memberId) => {
    try {
      const res = await axios.get(getFullApiUrl(`/api/members/${memberId}/files`));
      setMemberFiles(res.data);
    } catch (err) {
      console.error('Failed to fetch member files', err);
    }
  };

  const uploadMemberFile = async (memberId, file, description = '') => {
    try {
      setUploadingFile(true);
      const formData = new FormData();
      formData.append('file', file);
      if (description) {
        formData.append('description', description);
      }
      if (currentUser) {
        formData.append('uploaderId', currentUser.id);
      }
      const res = await axios.post(getFullApiUrl(`/api/members/${memberId}/files`), formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      });
      showNotification('文件上传成功！');
      await fetchMemberFiles(memberId);
      return res.data.file;
    } catch (err) {
      console.error('Failed to upload file', err);
      showNotification(err.response?.data?.error || '上传失败', 'error');
    } finally {
      setUploadingFile(false);
    }
  };

  const deleteMemberFile = async (fileId, memberId) => {
    try {
      await axios.delete(getFullApiUrl(`/api/files/${fileId}`));
      showNotification('文件删除成功！');
      await fetchMemberFiles(memberId);
    } catch (err) {
      console.error('Failed to delete file', err);
      showNotification('删除失败', 'error');
    }
  };

  const formatFileSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const prepareFileForPreview = async (fileId) => {
    try {
      const response = await axios.get(getFullApiUrl(`/api/files/${fileId}/prepare`));
      return response.data;
    } catch (err) {
      console.error('Failed to prepare file for preview:', err);
      showNotification('准备预览文件失败', 'error');
      return null;
    }
  };

  // 根据文件扩展名获取媒体类型
  const getMediaType = (filename) => {
    const ext = filename.split('.').pop()?.toLowerCase();
    const mimeTypes = {
      'pdf': 'application/pdf',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'doc': 'application/msword',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'xls': 'application/vnd.ms-excel',
      'zip': 'application/zip',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'apk': 'application/vnd.android.package-archive'
    };
    return mimeTypes[ext] || 'application/octet-stream';
  };

  const deleteTempFile = async (tempFileName) => {
    try {
      if (tempFileName) {
        await axios.delete(getFullApiUrl(`/api/temp-files/${tempFileName}`));
      }
    } catch (err) {
      console.error('Failed to delete temp file:', err);
    }
  };



  // 文件下载处理函数 - 支持Capacitor和浏览器环境
  const downloadFile = useCallback(async (fileUrl, filename, openWithDefaultApp = true) => {
    try {
      console.log('downloadFile called:', { fileUrl, filename, openWithDefaultApp });
      showNotification('开始下载文件...', 'success');
      
      // 检查是否在原生移动环境中
      if (window.Capacitor?.platform !== 'web') {
        console.log('Using Capacitor environment download method');
        
        try {
          // 首先尝试使用 Browser 插件在新窗口打开
          const { Browser } = window.Capacitor.Plugins || {};
          
          if (Browser && Browser.open) {
            console.log('Opening file with Browser plugin');
            await Browser.open({ 
              url: fileUrl,
              toolbarColor: '#2563EB'
            });
            showNotification(`正在打开: ${filename}`, 'success');
            return;
          }
        } catch (browserError) {
          console.error('Browser open failed:', browserError);
        }
        
        // 如果 Browser 不可用，尝试使用直接链接
        console.log('Browser not available, using direct link');
        const link = document.createElement('a');
        link.href = fileUrl;
        link.download = filename;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        showNotification('文件下载已开始', 'success');
        return;
      }
      
      // 浏览器环境使用传统方法
      console.log('Using browser download method');
      const link = document.createElement('a');
      link.href = fileUrl;
      link.download = filename;
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      showNotification('文件下载已开始', 'success');
    } catch (error) {
      console.error('Download failed:', error);
      showNotification('下载失败，请重试', 'error');
    }
  }, []);

  const showNotification = (message, type = 'success') => {
    setNotification({ show: true, message, type });
    setTimeout(() => {
      setNotification({ show: false, message: '', type: 'success' });
    }, 2000);
  };

  // APK上传处理
  const handleApkUpload = async () => {
    if (!apkFile) {
      showNotification('请选择APK文件', 'error');
      return;
    }
    setUploadingApk(true);
    try {
      const formData = new FormData();
      formData.append('apk', apkFile);
      formData.append('version', apkVersion);
      formData.append('versionCode', apkVersionCode);
      formData.append('updateRequired', apkUpdateRequired.toString());
      formData.append('releaseNotes', apkReleaseNotes);

      const res = await axios.post(getFullApiUrl('/api/admin/upload-apk'), formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      });

      showNotification('APK上传成功！', 'success');
      setShowApkUploadModal(false);
      setApkFile(null);
    } catch (err) {
      console.error('APK upload failed:', err);
      showNotification(err.response?.data?.error || '上传失败', 'error');
    } finally {
      setUploadingApk(false);
    }
  };

  // 获取APK版本号
  const getApkVersion = async () => {
    try {
      // 尝试从version.json读取版本号
      const res = await fetch('/version.json');
      if (res.ok) {
        const data = await res.json();
        return data.versionCode || 1;
      }
    } catch (err) {
      console.log('Could not read version from APK, using default');
    }
    return 1; // 默认版本号
  };

  // 检查更新
  const checkForUpdate = async () => {
    // 只在原生移动应用中检查更新，浏览器不检查更新
    if (window.Capacitor?.platform === 'web') {
      return;
    }

    try {
      const currentVersionCode = await getApkVersion();
      const res = await axios.post(getFullApiUrl('/api/apk/check-update'), {
        currentVersionCode
      });

      if (res.data.hasUpdate) {
        setUpdateInfo(res.data);
        setShowUpdateModal(true);
      }
    } catch (err) {
      console.error('Check update failed:', err);
    }
  };

  // 下载并安装更新
  const downloadAndInstallUpdate = () => {
    setDownloadingUpdate(true);
    // 在实际的Android应用中，这里会使用Capacitor插件来下载和安装APK
    // 这里我们提供一个下载链接
    window.open(getFullApiUrl('/api/apk/download'), '_blank');
    setDownloadingUpdate(false);
    
    // 如果是强制更新，不允许关闭模态框
    if (!updateInfo?.updateRequired) {
      setShowUpdateModal(false);
    }
  };

  // 稍后再说
  const handleRemindLater = () => {
    setShowUpdateModal(false);
  };

  // 获取当前版本信息
  const fetchCurrentVersion = async () => {
    try {
      const res = await axios.get(getFullApiUrl('/api/apk/version'));
      setCurrentVersionInfo(res.data);
    } catch (err) {
      console.error('Failed to fetch current version:', err);
    }
  };

  // 设置版本信息
  const handleSetVersion = async () => {
    console.log('handleSetVersion called');
    console.log('apkVersion:', apkVersion);
    console.log('apkVersionCode:', apkVersionCode);
    
    if (!apkVersion || !apkVersionCode) {
      showNotification('请填写版本号和版本代码', 'error');
      return;
    }
    setSettingVersion(true);
    try {
      // 强制使用localhost，确保修改本地build.gradle
      const apiUrl = 'http://localhost:3001';
      console.log('Sending request to:', `${apiUrl}/api/admin/apk/set-version`);
      const response = await axios.post(`${apiUrl}/api/admin/apk/set-version`, {
        version: apkVersion,
        versionCode: apkVersionCode
      });
      console.log('Response:', response);
      showNotification('版本信息设置成功！', 'success');
      setShowSetVersionModal(false);
    } catch (err) {
      console.error('Failed to set version:', err);
      showNotification(err.response?.data?.error || '设置失败', 'error');
    } finally {
      setSettingVersion(false);
    }
  };

  const initPlayMode = async () => {
    setIsPlayModeLoading(true);
    setView('login');
    try {
      let conf = null;
      try { const pc = await axios.get(getFullApiUrl('/api/playmode')); conf = pc.data || null; } catch (e) { console.warn('[play] playmode 配置读取失败，走默认', e); }
      setPlayConf(conf);
      const lastWeek = Math.max(1, config.currentWeek - 1);
      const classData = [];
      
      for (const className of classes) {
        const classMembers = members.filter(m => m.class === className);
        const classMembersWithScores = [];
        
        for (const member of classMembers) {
          try {
            const res = await axios.get(getFullApiUrl(`/api/stats/${member.id}`));
            const memberStats = res.data;
            const lastWeekStats = memberStats.find(s => s.week === lastWeek);
            if (lastWeekStats) {
              // 保存完整的stats数组和上周的周次
              classMembersWithScores.push({ 
                member, 
                stats: lastWeekStats,
                allStats: memberStats,
                currentWeek: lastWeek
              });
            } else {
              classMembersWithScores.push({ member, stats: null, allStats: [], currentWeek: null });
            }
          } catch (err) {
            console.error(`Failed to fetch stats for ${member.name}`, err);
            classMembersWithScores.push({ member, stats: null, allStats: [], currentWeek: null });
          }
        }
        
        if (classMembersWithScores.length > 0) {
          classData.push({ className, members: classMembersWithScores });
        }
      }
      
      setPlayModeClasses(classData);

      // 播放清单展开：配置缺失/空 → 全部班级按序（每页 6 人，radarDuration/页）
      const radarDur = (conf && Number(conf.radarDuration)) || 8;
      const keepAlive = (conf && Number(conf.keepAlive)) || 3;
      keepUrlRef.current = keepAlive;
      setPlayKeepAlive(keepAlive);
      const frames = [];
      const pushRadarClass = (ci, dur) => {
        const cd = classData[ci];
        const total = Math.ceil(cd.members.length / 6);
        for (let p = 0; p < total; p++) frames.push({ kind: 'radar', classIdx: ci, className: cd.className, page: p, duration: dur });
      };
      const items = conf && Array.isArray(conf.items) && conf.items.length > 0 ? conf.items : null;
      // 雷达恒在：班级雷达始终作为播放主循环。清单未显式含 class 项（纯图片/网页
      // 清单）时，默认全部班级雷达帧打底，image/url 帧再按清单顺序接续轮播——
      // 无论清单里有没有图片/网页，雷达图都参与循环。
      const hasClassItem = items ? items.some(it => it.type === 'class') : false;
      if (items) {
        if (!hasClassItem) classData.forEach((_, ci) => pushRadarClass(ci, radarDur));
        for (const it of items) {
          const dur = Number(it.duration) || radarDur;
          if (it.type === 'class') {
            const ci = classData.findIndex(c => c.className === it.className);
            if (ci < 0) { console.warn(`[play] 丢弃不存在的班级 ${it.className}`); continue; }
            pushRadarClass(ci, dur);
          } else if (it.type === 'image' || it.type === 'url') {
            if (!/^https?:\/\//i.test(it.url || '')) { console.warn(`[play] 丢弃非法 ${it.type}: ${it.url}`); continue; }
            frames.push({ kind: it.type, key: it.id, url: it.url, label: it.label || hostOf(it.url), duration: dur });
          }
        }
      } else {
        classData.forEach((_, ci) => pushRadarClass(ci, radarDur));
      }
      // 图片预载：进入播放即缓存，切换不闪
      frames.forEach(f => { if (f.kind === 'image') { const im = new Image(); im.src = f.url; } });

      setPlayFrames(frames);
      setPlayFrameIdx(0);
      setUrlKept([]);
      setTimeout(() => {
        setIsPlayModeLoading(false);
        setView('play');
      }, 1200);
    } catch (err) {
      console.error('Failed to init play mode', err);
      showNotification('播放模式初始化失败', 'error');
      setIsPlayModeLoading(false);
    }
  };

  // 实际提交评分的函数
  const doSubmitScore = async () => {
    try {
      const type = currentUser.id === targetMember.id ? 'self' : 'peer';
      // 计算最终的六维评分
      const finalScores = getDimensionScores();
      await axios.post(getFullApiUrl('/api/scores'), {
        week: selectedWeek,
        semesterId: selectedSemesterId || config.currentSemesterId,
        memberId: targetMember.id,
        evaluatorId: currentUser.id,
        type,
        scores: finalScores,
        subItemScores,
      });
      
      // 提交关系提名、心情标签和心理自评（仅在自评时提交一次）
      if (currentUser.id === targetMember.id) {
        try {
          await axios.post(getFullApiUrl('/api/relationship-nominations'), {
            evaluatorId: currentUser.id,
            positiveNominations,
            negativeNominations,
            moodTag: selectedMoodTag,
            selfAssessment
          });
        } catch (nominationErr) {
          console.error('Failed to submit relationship nomination:', nominationErr);
          // 不阻止评分提交，即使提名提交失败
        }
      }
      
      showNotification('评分提交成功！');
      fetchStats(targetMember.id);
      fetchScoredIds(currentUser.id, selectedWeek);
    } catch (err) {
      if (err.response && err.response.data && err.response.data.error) {
        showNotification(err.response.data.error, 'error');
      } else {
        console.error('Failed to submit score', err);
        showNotification('提交失败，请重试', 'error');
      }
    }
  };

  const submitScore = async () => {
    // 检测异常
    const warnings = detectScoreAnomalies(subItemScores);
    
    // 检查是否有连续两周评分完全相同（拦截，不允许提交）
    const hasConsecutiveIdentical = warnings.some(w => w.code === 'CONSECUTIVE_IDENTICAL');
    if (hasConsecutiveIdentical) {
      showNotification('连续两周评分完全相同，请根据实际情况重新评分', 'error');
      return;
    }
    
    // 如果有警告（包括单次相同的中度提醒），显示弹窗
    if (warnings.length > 0) {
      setScoreWarnings(warnings);
      setShowScoreWarningModal(true);
      setPendingSubmit(true);
    } else {
      // 没有警告，直接提交
      await doSubmitScore();
    }
  };

  // 注册设备以接收通知（前台服务保活方案）
  const registerDevice = async (memberId) => {
    try {
      pushLog(`==== registerDevice 开始, memberId=${memberId}, isCapacitorNative=${isCapacitorNative} ====`);
      const deviceToken = localStorage.getItem('deviceToken') || `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem('deviceToken', deviceToken);

      const devResp = await axios.post(getFullApiUrl('/api/devices/register'), {
        memberId, token: deviceToken, platform: isCapacitorNative ? 'capacitor' : 'web'
      });
      pushLog(`设备注册: HTTP ${devResp.status}`);

      // Web 端：走 Web Push
      if (!isCapacitorNative) {
        if ('serviceWorker' in navigator && 'PushManager' in window) {
          try {
            const registration = await navigator.serviceWorker.ready;
            let subscription = await registration.pushManager.getSubscription();
            if (!subscription) {
              const vapidRes = await axios.get(getFullApiUrl('/api/push/vapid-public-key'));
              const publicKey = vapidRes.data.publicKey;
              subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey)
              });
            }
            await axios.post(getFullApiUrl('/api/push/subscribe'), { memberId, subscription });
            pushLog('Web Push 注册成功');
          } catch (webPushErr) {
            pushLog(`Web Push 失败: ${webPushErr.message}`, 'warn');
          }
        }
        pushLog('==== registerDevice 结束 ====');
        return;
      }

      // 原生端：请求通知权限 + 启动前台保活服务
      const cap = window.Capacitor || {};
      const { LocalNotifications, JPush } = cap.Plugins || {};

      // Android 13+ 通知权限
      try {
        if (LocalNotifications?.requestPermissions) {
          const perm = await LocalNotifications.requestPermissions();
          pushLog(`通知权限: ${perm.display}`);
        }
      } catch (e) {
        pushLog(`请求通知权限失败: ${e.message}`, 'warn');
      }

      // 启动前台保活服务
      if (JPush?.startForegroundService) {
        try {
          // 去掉末尾 / 和 /api，避免拼接出 //api/push/inbox
          const rawUrl = typeof getFullApiUrl === 'function' ? getFullApiUrl('/') : '/';
          const apiUrl = rawUrl.replace(/\/api\/?$/, '').replace(/\/+$/, '');
          const lastNotifId = localStorage.getItem(`push_lastNotifId_${memberId}`) || null;
          pushLog(`前台服务参数: apiUrl=${apiUrl}, memberId=${memberId}, lastNotifId=${lastNotifId || '(空)'}`);
          await JPush.startForegroundService({
            apiUrl,
            memberId: String(memberId),
            lastNotifId
          });
          pushLog('前台保活服务已启动');
          // 检查后台保活权限（电池优化白名单）
          try {
            if (JPush.checkBatteryOptimization) {
              const bat = await JPush.checkBatteryOptimization();
              const brand = bat.brand || (window.Capacitor?.getPlatform?.() || '');
              setPermCheckResult({ batteryIgnored: bat.isIgnored, brand });
              // 未加入电池优化白名单 → 显示引导弹窗
              if (!bat.isIgnored) {
                // 已确认过则不再弹（用户可手动重新触发）
                if (!localStorage.getItem('push_perm_confirmed')) {
                  setShowPermissionGuide(true);
                }
              }
            }
          } catch (e) {
            pushLog(`检查电池优化失败: ${e.message}`, 'warn');
          }
        } catch (fgErr) {
          pushLog(`启动前台服务失败: ${fgErr.message || fgErr}`, 'error');
        }
      } else {
        pushLog('startForegroundService 方法不可用', 'error');
      }
      pushLog('==== registerDevice 结束 ====');
    } catch (err) {
      pushLog(`registerDevice 异常: ${err.message}`, 'error');
    }
  };

  // 前台运行时拉取 inbox（与原生服务并行，提升前台实时性）
  useEffect(() => {
    if (!currentUser?.id || !isCapacitorNative) return;
    let timer = null;
    let lastId = localStorage.getItem(`push_lastNotifId_${currentUser.id}`) || null;
    const strHash = (s) => {
      let h = 0;
      for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h) + s.charCodeAt(i);
        h |= 0;
      }
      return Math.abs(h);
    };
    const poll = async () => {
      try {
        // 长轮询：服务端 hold 最多 25s，有新消息立即返回；axios timeout 30s 略大于 hold
        const res = await axios.get(getFullApiUrl(`/api/push/inbox/${currentUser.id}`), {
          params: { wait: 25, ...(lastId ? { since: lastId } : {}) },
          timeout: 30000
        });
        if (res.data?.notifications?.length > 0) {
          const { LocalNotifications } = window.Capacitor?.Plugins || {};
          for (const n of res.data.notifications) {
            if (LocalNotifications) {
              try {
                // 解析 extras（后端可能存为对象或字符串）
                let extraData = null;
                if (n.extras) {
                  try {
                    extraData = typeof n.extras === 'string' ? JSON.parse(n.extras) : n.extras;
                  } catch (e) { extraData = null; }
                }
                await LocalNotifications.schedule({
                  notifications: [{
                    title: n.title,
                    body: n.body,
                    id: strHash(n.id),
                    schedule: { at: new Date(Date.now() + 100) },
                    extra: extraData || {}
                  }]
                });
              } catch (e) {}
            }
            lastId = n.id;
            localStorage.setItem(`push_lastNotifId_${currentUser.id}`, lastId);
          }
        }
      } catch (e) {
        // 超时/网络错误：稍等 1s 再重试，避免快速循环
        await new Promise(r => setTimeout(r, 1000));
      }
      // 递归发起下一次长轮询（未被取消才继续）
      if (!cancelled) poll();
    };
    let cancelled = false;
    poll();
    return () => { cancelled = true; };
  }, [currentUser, isCapacitorNative]);

  // 取消推送订阅
  const unregisterPush = async (memberId) => {
    try {
      if (isCapacitorNative) {
        // 原生端停止前台服务
        const { JPush } = window.Capacitor?.Plugins || {};
        if (JPush?.stopForegroundService) {
          try { await JPush.stopForegroundService(); } catch (e) {}
        }
      } else if ('serviceWorker' in navigator && 'PushManager' in window) {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) await subscription.unsubscribe();
      }
      await axios.post(getFullApiUrl('/api/push/unsubscribe'), { memberId });
    } catch (err) {
      console.error('Failed to unregister push:', err);
    }
  };

  // 通知点击监听（点击推送后跳转每日一问弹窗，需先登录）
  // 流程：用户点击通知 → 系统拉起 APP → 检查登录状态 → 已登录则弹每日一问，未登录则存 pending，登录后自动弹出
  useEffect(() => {
    const { LocalNotifications } = window.Capacitor?.Plugins || {};
    if (!LocalNotifications?.addListener) return;

    const handleRouteFromExtra = (extra) => {
      try {
        if (!extra) return;
        const obj = typeof extra === 'string' ? JSON.parse(extra) : extra;
        if (obj?.route === 'dailyQuestion') {
          // 必须先登录才显示弹窗
          if (currentUser?.id) {
            setShowDailyQuestion(true);
            console.log('[Push] 点击通知 → 已登录 → 显示每日一问弹窗');
          } else {
            // 未登录：缓存路由，登录后自动弹出
            localStorage.setItem('pendingPushRoute', JSON.stringify(obj));
            console.log('[Push] 点击通知 → 未登录 → 缓存路由，登录后弹出');
          }
        }
      } catch (e) {
        console.error('[Push] 解析 extras 跳转失败:', e);
      }
    };

    const handles = [];
    const register = (eventName, handler) => {
      try {
        const ret = LocalNotifications.addListener(eventName, handler);
        if (ret && typeof ret.then === 'function') {
          ret.then(h => { if (h) handles.push(h); }).catch(() => {});
        } else if (ret) {
          handles.push(ret);
        }
      } catch (e) {
        console.error(`[Push] addListener(${eventName}) 失败:`, e);
      }
    };

    // 收到通知时仅记录日志（不跳转，避免在后台频繁弹窗）
    register('localNotificationReceived', (notification) => {
      console.log('[Push] 收到本地通知:', notification?.title);
    });

    // 用户点击通知时触发跳转
    register('localNotificationActionPerformed', (actionEvent) => {
      try {
        const notif = actionEvent?.notification || {};
        console.log('[Push] 通知点击:', notif.title);
        // Capacitor 中附加数据在 extra 字段
        handleRouteFromExtra(notif.extra || notif.extras);
      } catch (e) {
        console.error('[Push] 通知点击处理失败:', e);
      }
    });

    // APP 从通知启动时检查 pending 路由
    try {
      const pending = localStorage.getItem('pendingPushRoute');
      if (pending) {
        localStorage.removeItem('pendingPushRoute');
        // 若已登录则立即弹出
        if (currentUser?.id) {
          const obj = JSON.parse(pending);
          if (obj?.route === 'dailyQuestion') {
            setTimeout(() => setShowDailyQuestion(true), 800);
            console.log('[Push] 启动时检测到 pending 路由 → 已登录 → 显示弹窗');
          }
        }
      }
    } catch (e) {}

    return () => {
      handles.forEach(h => {
        try { if (h && typeof h.remove === 'function') h.remove(); } catch (e) {}
      });
    };
  }, [currentUser]);

  // 登录成功后检查 pending 推送路由
  useEffect(() => {
    if (!currentUser?.id) return;
    try {
      const pending = localStorage.getItem('pendingPushRoute');
      if (pending) {
        localStorage.removeItem('pendingPushRoute');
        const obj = JSON.parse(pending);
        if (obj?.route === 'dailyQuestion') {
          // 延迟弹出，等待主界面渲染完成
          setTimeout(() => setShowDailyQuestion(true), 600);
          console.log('[Push] 登录后自动弹出每日一问');
        }
      }
    } catch (e) {}
  }, [currentUser]);

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  // 获取通知列表
  const fetchNotifications = async (memberId) => {
    try {
      const res = await axios.get(getFullApiUrl(`/api/notifications/${memberId}`));
      setNotifications(res.data);
      const unread = res.data.filter(n => !n.read).length;
      setUnreadCount(unread);
    } catch (err) {
      console.error('Failed to fetch notifications:', err);
    }
  };

  // 标记通知为已读
  const markNotificationRead = async (notificationId) => {
    try {
      await axios.put(getFullApiUrl(`/api/notifications/${notificationId}/read`));
      setNotifications(prev => prev.map(n => 
        n.id === notificationId ? { ...n, read: true } : n
      ));
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch (err) {
      console.error('Failed to mark notification read:', err);
    }
  };

  // Start polling for queue status
  const startPolling = (queueId) => {
    if (pollingInterval) {
      clearInterval(pollingInterval);
    }
    
    const interval = setInterval(async () => {
      try {
        const res = await axios.get(getFullApiUrl(`/api/ai/queue-status?queueId=${queueId}`));
        const { queuePosition } = res.data;
        
        if (queuePosition === null) {
          // Request has been processed, stop polling
          clearInterval(interval);
          setIsPolling(false);
          setQueueStatus({ inQueue: false, queuePosition: null, queueId: null });
          
          // Retry the analysis request
          if (isPublicView) {
            analyzeAll();
          } else {
            analyzeIndividual();
          }
        } else {
          // Update queue position
          setQueueStatus(prev => ({
            ...prev,
            queuePosition
          }));
        }
      } catch (err) {
        console.error('Failed to poll queue status', err);
        clearInterval(interval);
        setIsPolling(false);
        setQueueStatus({ inQueue: false, queuePosition: null, queueId: null });
        showNotification('轮询队列状态失败', 'error');
      }
    }, 2000); // Poll every 2 seconds
    
    setPollingInterval(interval);
    setIsPolling(true);
  };

  // Stop polling
  const stopPolling = () => {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      setPollingInterval(null);
      setIsPolling(false);
    }
    setQueueStatus({ inQueue: false, queuePosition: null, queueId: null });
  };

  const analyzeIndividual = async () => {
    try {
      setAnalysisLoading(true);
      setAnalysisResult('');
      setShowAnalysisModal(true);
      setShowAnalysisLoader(false);
      stopPolling();
      analysisAutoScroll.current = true;

      const response = await fetch(getFullApiUrl('/api/ai/analyze/member/stream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: targetMember?.id })
      });

      if (!response.ok) {
        throw new Error('请求失败');
      }

      setShowAnalysisModal(true);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'content') {
                setAnalysisResult(prev => prev + data.content);
                if (analysisAutoScroll.current && analysisRef.current) {
                  analysisRef.current.scrollTop = analysisRef.current.scrollHeight;
                }
              } else if (data.type === 'error') {
                showNotification(data.content, 'error');
              }
            } catch (e) {
              // ignore parse errors
            }
          }
        }
      }
    } catch (err) {
      console.error('Failed to analyze', err);
      showNotification(err.message || '分析失败', 'error');
    } finally {
      setAnalysisLoading(false);
      setShowAnalysisLoader(false);
    }
  };

  const analyzeAll = async () => {
    try {
      setAnalysisLoading(true);
      setAnalysisResult('');
      setShowAnalysisModal(true);
      setShowAnalysisLoader(false);
      stopPolling();
      analysisAutoScroll.current = true;

      const response = await fetch(getFullApiUrl('/api/ai/analyze/all/stream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) {
        throw new Error('请求失败');
      }

      setShowAnalysisModal(true);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'content') {
                setAnalysisResult(prev => prev + data.content);
                if (analysisAutoScroll.current && analysisRef.current) {
                  analysisRef.current.scrollTop = analysisRef.current.scrollHeight;
                }
              } else if (data.type === 'error') {
                showNotification(data.content, 'error');
              }
            } catch (e) {
              // ignore parse errors
            }
          }
        }
      }
    } catch (err) {
      console.error('Failed to analyze all', err);
      showNotification(err.message || '分析失败', 'error');
    } finally {
      setAnalysisLoading(false);
      setShowAnalysisLoader(false);
    }
  };

  const downloadWord = async () => {
    try {
      const title = isPublicView ? '班级评分系统全体数据分析报告' : `${maskName(targetMember?.name)}同学的评分分析报告`;
      const res = await axios.post(getFullApiUrl('/api/ai/download-word'), {
        analysis: analysisResult,
        title
      }, {
        responseType: 'blob'
      });

      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `${title}.docx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);

      showNotification('下载成功！');
    } catch (err) {
      console.error('Failed to download word', err);
      showNotification('下载失败', 'error');
    }
  };

  // 登录缓存
  const saveLoginCache = (loginData) => {
    localStorage.setItem('loginCache', JSON.stringify({
      ...loginData,
      timestamp: Date.now()
    }));
  };

  const autoLoginRan = useRef(false);
  const loginModalOpen = useRef(false);
  // 密码框打开时在 onClick 中同步设 ref（比 useEffect 快，杜绝竞态）

  // App 启动时检查登录缓存 —— 只在首次 members 加载完成且未登录时自动恢复
  useEffect(() => {
    if (autoLoginRan.current) return;
    if (!members || members.length === 0) return;
    if (loginModalOpen.current) return;
    autoLoginRan.current = true;
    try {
      const cached = localStorage.getItem('loginCache');
      if (!cached) return;
      const data = JSON.parse(cached);
      const { type, memberId, memberName, memberClass, deviceId } = data;
      if (!type || !memberId) return;

      if (type === 'student') {
        const mem = members.find(m => String(m.id) === String(memberId));
        if (!mem) return;
        setIsAdmin(false);
        setIsSuperAdmin(false);
        setIsPublicView(false);
        setCurrentUser({ id: mem.id, name: mem.name, class: mem.class });
        setPositiveNominationClass(mem.class);
        setNegativeNominationClass(mem.class);
        setSelectedClass(mem.class);
        setTargetMember(mem);
        setView('dashboard');
        fetchStats(mem.id);
        registerDevice(mem.id);
        fetchNotifications(mem.id);
      } else if (type === 'admin') {
        setIsAdmin(true);
        setIsSuperAdmin(false);
        setIsPublicView(true);
        setCurrentUser({ id: memberId, name: memberName, class: '全校', deviceId });
        setPositiveNominationClass(classes[0] || '');
        setNegativeNominationClass(classes[0] || '');
        setSelectedClass(classes[0] || '');
        setView('dashboard');
        const tm = members.find(m => m.class === classes[0]);
        if (tm) { setTargetMember(tm); fetchStats(tm.id); }
        fetchCurrentVersion();
      } else if (type === 'superadmin') {
        setIsAdmin(true);
        setIsSuperAdmin(true);
        setIsPublicView(true);
        setCurrentUser({ id: 'superadmin', name: '后台管理员', class: '全校', deviceId });
        setPositiveNominationClass(classes[0] || '');
        setNegativeNominationClass(classes[0] || '');
        setSelectedClass(classes[0] || '');
        setView('dashboard');
        const tm = members.find(m => m.class === classes[0]);
        if (tm) { setTargetMember(tm); fetchStats(tm.id); }
        fetchCurrentVersion();
      }
    } catch (e) {}
  }, [members]);

  const handlePasswordVerify = async () => {
    if (!passwordInput) {
      showNotification('请输入密码', 'error');
      return;
    }
    try {
      const res = await axios.post(getFullApiUrl('/api/member/verify-password'), {
        memberId: pendingMember.id,
        password: passwordInput
      });
      if (res.data.success) {
        // 登录成功后清除旧缓存，写入新缓存
        loginModalOpen.current = false;
        localStorage.removeItem('loginCache');
        setShowPasswordModal(false);
        setPasswordInput('');
        setIsAdmin(false);
        setIsPublicView(false);
        setIsSuperAdmin(false);
        setCurrentUser(pendingMember);
        setPositiveNominationClass(pendingMember.class);
        setNegativeNominationClass(pendingMember.class);
        setView('dashboard');
        setTargetMember(pendingMember);
        fetchStats(pendingMember.id);
        registerDevice(pendingMember.id);
        fetchNotifications(pendingMember.id);
        saveLoginCache({ type: 'student', memberId: pendingMember.id, memberName: pendingMember.name, memberClass: pendingMember.class });
        showNotification('登录成功！');
      } else {
        showNotification(res.data.error || '密码错误', 'error');
      }
    } catch (err) {
      console.error('Password verify failed', err);
      if (err.response?.data?.error === 'PASSWORD_NOT_SET') {
        setPasswordMode('set');
        showNotification('密码未设置，请先设置密码', 'error');
      } else {
        showNotification(err.response?.data?.error || '密码错误', 'error');
      }
    }
  };

  const handlePasswordSet = async () => {
    if (!passwordInput) {
      showNotification('请输入密码', 'error');
      return;
    }
    if (passwordInput.length < 4) {
      showNotification('密码长度至少4位', 'error');
      return;
    }
    try {
      const res = await axios.post(getFullApiUrl('/api/member/set-password'), {
        memberId: pendingMember.id,
        password: passwordInput
      });
      if (res.data.success) {
        loginModalOpen.current = false;
        setShowPasswordModal(false);
        setPasswordInput('');
        setIsAdmin(false);
        setIsPublicView(false);
        setIsSuperAdmin(false);
        setCurrentUser(pendingMember);
        setPositiveNominationClass(pendingMember.class);
        setNegativeNominationClass(pendingMember.class);
        setView('dashboard');
        setTargetMember(pendingMember);
        fetchStats(pendingMember.id);
        registerDevice(pendingMember.id);
        fetchNotifications(pendingMember.id);
        showNotification('密码设置成功！');
      }
    } catch (err) {
      console.error('Password set failed', err);
      showNotification(err.response?.data?.error || '密码设置失败', 'error');
    }
  };

  // 生成或读取设备指纹（用于区分不同管理员）
  // 优先级：微信绑定ID > 已生成的adminDeviceToken > 新生成
  const getAdminDeviceId = () => {
    // 如果已有微信绑定的管理员Bot ID，优先用它作为设备标识
    const wechatBotId = localStorage.getItem('adminBotMemberId');
    if (wechatBotId) return wechatBotId;

    let deviceToken = localStorage.getItem('adminDeviceToken');
    if (!deviceToken) {
      deviceToken = 'admin_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
      localStorage.setItem('adminDeviceToken', deviceToken);
    }
    return deviceToken;
  };

  // 获取管理员短标识（用于界面显示）
  const getAdminShortId = () => {
    const full = getAdminDeviceId();
    return '管理员 ' + full.replace('admin_', '').substring(0, 4).toUpperCase();
  };

  const handleAdminPasswordVerify = async () => {
    if (!adminPasswordInput) {
      loginModalOpen.current = false;
      setShowAdminPasswordModal(false);
      setIsPublicView(true);
      setIsAdmin(false);
      setIsSuperAdmin(false);
      setCurrentUser({ name: '游客', class: '公共', id: 'guest' });
      setPositiveNominationClass('公共');
      setNegativeNominationClass('公共');
      setSelectedClass(classes[0]);
      setView('dashboard');
      return;
    }

    // 检查是否是后台管理密码
    if (adminPasswordInput === 'dxys5lpo') {
      loginModalOpen.current = false;
      setShowAdminPasswordModal(false);
      setAdminPasswordInput('');
      setIsPublicView(true);
      setIsAdmin(true);
      setIsSuperAdmin(true);
      setCurrentUser({ name: '后台管理员', class: '全校', id: 'superadmin', deviceId: getAdminDeviceId() });
      setPositiveNominationClass(classes[0]);
      setNegativeNominationClass(classes[0]);
      setSelectedClass(classes[0]);
      setView('dashboard');
      setTargetMember(members.find(m => m.class === classes[0]));
      if (members.find(m => m.class === classes[0])) {
        fetchStats(members.find(m => m.class === classes[0]).id);
      }
      fetchCurrentVersion();
      localStorage.removeItem('loginCache');
      saveLoginCache({ type: 'superadmin', memberId: 'superadmin', deviceId: getAdminDeviceId() });
      showNotification('后台管理模式登录成功！');
      return;
    }

    try {
      const deviceId = getAdminDeviceId();
      const res = await axios.post(getFullApiUrl('/api/admin/verify-password'), {
        password: adminPasswordInput,
        adminDeviceId: deviceId
      });
      if (res.data.success) {
        // 登录成功后清除旧缓存，写入新缓存
        loginModalOpen.current = false;
        localStorage.removeItem('loginCache');

        // 如果服务端返回了已有的 adminId（跨设备识别），使用它
        const effectiveId = res.data.adminId || deviceId;
        const effectiveNickname = res.data.nickname || getAdminShortId();

        // 同步到 localStorage（覆盖本地生成的设备 ID）
        if (res.data.adminId && res.data.adminId !== deviceId) {
          localStorage.setItem('adminDeviceToken', res.data.adminId);
          localStorage.setItem('adminBotMemberId', res.data.adminId);
        }

        if (res.data.needsNickname) {
          // 首次登录，需要设置昵称
          // 把真实密码暂存到 ref，供 set-nickname 接口复用（不能清空，否则会 fallback 到硬编码默认密码导致 401）
          adminPasswordStashRef.current = adminPasswordInput;
          setAdminNicknameInput(effectiveNickname);
          setShowAdminNicknameModal(true);
          setAdminPasswordInput('');
          return;
        }

        const adminName = effectiveNickname;
        setShowAdminPasswordModal(false);
        setAdminPasswordInput('');
        setIsPublicView(true);
        setIsAdmin(true);
        setIsSuperAdmin(false);
        setCurrentUser({ name: adminName, class: '全校', id: effectiveId, deviceId: effectiveId });
        setPositiveNominationClass(classes[0]);
        setNegativeNominationClass(classes[0]);
        setSelectedClass(classes[0]);
        setView('dashboard');
        setTargetMember(members.find(m => m.class === classes[0]));
        if (members.find(m => m.class === classes[0])) {
          fetchStats(members.find(m => m.class === classes[0]).id);
        }
        fetchCurrentVersion();
        saveLoginCache({ type: 'admin', memberId: effectiveId, memberName: adminName, memberClass: '全校', deviceId: effectiveId });
        showNotification(`${adminName} 登录成功！`);
      } else {
        showNotification(res.data.error || '密码错误', 'error');
      }
    } catch (err) {
      console.error('Admin password verify failed', err);
      const errorMessage = err.response?.data?.error || '密码错误';
      showNotification(errorMessage, 'error');
    }
  };

  const handleSetAdminPassword = async () => {
    if (!newPasswordInput) {
      showNotification('请输入新密码', 'error');
      return;
    }
    if (newPasswordInput.length < 4) {
      showNotification('密码长度至少4位', 'error');
      return;
    }
    if (newPasswordInput !== confirmPasswordInput) {
      showNotification('两次输入的密码不一致', 'error');
      return;
    }
    try {
      const res = await axios.post(getFullApiUrl('/api/admin/set-password'), {
        newPassword: newPasswordInput,
        confirmPassword: confirmPasswordInput
      });
      if (res.data.success) {
        setShowSetPasswordModal(false);
        setOldPasswordInput('');
        setNewPasswordInput('');
        setConfirmPasswordInput('');
        fetchConfig();
        showNotification('管理密码设置成功！');
      }
    } catch (err) {
      console.error('Set admin password failed', err);
      showNotification(err.response?.data?.error || '设置失败', 'error');
    }
  };

  const fetchMemberDetail = async (memberId) => {
    try {
      const [detailRes, rankRes, filesRes, noticesRes, dutiesRes] = await Promise.all([
        axios.get(getFullApiUrl(`/api/member/detail/${memberId}`)),
        axios.get(getFullApiUrl(`/api/rank-scores/${memberId}`)),
        axios.get(getFullApiUrl(`/api/members/${memberId}/files`)),
        axios.get(getFullApiUrl(`/api/notices/member/${memberId}`)),
        axios.get(getFullApiUrl(`/api/duties/member/${memberId}`))
      ]);
      setSelectedMemberDetail(detailRes.data);
      setSelectedMemberRank(rankRes.data);
      setMemberFiles(filesRes.data);
      setNotices(noticesRes.data);
      setDuties(dutiesRes.data);
      setProfileFormData({
        mbti: detailRes.data.member.mbti || '',
        birthday: detailRes.data.member.birthday || '',
        isBackbone: detailRes.data.member.isBackbone || false,
        position: detailRes.data.member.position || '',
        hobbies: detailRes.data.member.hobbies || '',
        hometown: detailRes.data.member.hometown || ''
      });
      setShowMemberDetailModal(true);
    } catch (err) {
      console.error('Failed to fetch member detail', err);
      showNotification('获取详细信息失败', 'error');
    }
  };

  // 判断是否是班长（班级名包含成员名）
  const isMonitor = (member) => {
    if (!member) return false;
    return member.class.includes(member.name);
  };

  const handleSaveDuty = async () => {
    if (!dutyForm.memberIds || dutyForm.memberIds.length === 0 || !dutyForm.content || !dutyForm.time) {
      showNotification('请完整填写公差信息', 'error');
      return;
    }
    try {
      setSavingDuty(true);
      await axios.post(getFullApiUrl('/api/duties'), {
        memberIds: dutyForm.memberIds,
        content: dutyForm.content,
        time: dutyForm.time,
        score: dutyForm.score ? parseFloat(dutyForm.score) : null,
        class: selectedMemberDetail?.member?.class || currentUser?.class || selectedClass,
        monitorId: currentUser?.id || 'monitor'
      });
      showNotification('公差记录添加成功！', 'success');
      setShowDutyModal(false);
      setDutyForm({
        memberIds: [],
        content: '',
        time: new Date().toISOString().split('T')[0],
        score: ''
      });
      // 刷新公差统计
      await fetchDutyStats();
      // 如果正在查看成员详情，刷新公差数据
      if (selectedMemberDetail?.member?.id) {
        fetchMemberDetail(selectedMemberDetail.member.id);
      }
      // 如果正在评分，刷新目标成员的公差数据
      if (targetMember) {
        fetchTargetMemberDuties(targetMember.id);
      }
    } catch (err) {
      console.error('Failed to save duty', err);
      showNotification('公差记录添加失败', 'error');
    } finally {
      setSavingDuty(false);
    }
  };

  const handleDeleteDuty = async (dutyId) => {
    try {
      await axios.delete(getFullApiUrl(`/api/duties/${dutyId}`), {
        data: { monitorId: currentUser?.id || 'monitor' }
      });
      showNotification('公差记录删除成功！', 'success');
      // 刷新公差统计
      await fetchDutyStats();
      // 刷新公差数据
      if (selectedMemberDetail?.member?.id) {
        fetchMemberDetail(selectedMemberDetail.member.id);
      }
      // 如果正在评分，刷新目标成员的公差数据
      if (targetMember) {
        fetchTargetMemberDuties(targetMember.id);
      }
    } catch (err) {
      console.error('Failed to delete duty', err);
      showNotification('公差记录删除失败', 'error');
    }
  };

  const fetchTargetMemberDuties = async (memberId) => {
    try {
      const res = await axios.get(getFullApiUrl(`/api/duties/member/${memberId}`));
      setTargetMemberDuties(res.data);
    } catch (err) {
      console.error('Failed to fetch target member duties', err);
      setTargetMemberDuties([]);
    }
  };

  const fetchDuties = async () => {
    try {
      const res = await axios.get(getFullApiUrl('/api/duties'));
      setDuties(res.data);
    } catch (err) {
      console.error('Failed to fetch duties', err);
      setDuties([]);
    }
  };

  const fetchDutyStats = async () => {
    try {
      const res = await axios.get(getFullApiUrl('/api/duties/stats'));
      setDutyStats(res.data);
    } catch (err) {
      console.error('Failed to fetch duty stats', err);
      setDutyStats({});
    }
  };

  const handleProfileSubmit = async () => {
    if (!selectedMemberDetail?.member?.id) return;
    try {
      await axios.post(getFullApiUrl('/api/member/update-info'), {
        memberId: selectedMemberDetail.member.id,
        mbti: profileFormData.mbti ? profileFormData.mbti.toUpperCase() : null,
        birthday: profileFormData.birthday || null,
        isBackbone: profileFormData.isBackbone,
        position: profileFormData.position || null,
        hobbies: profileFormData.hobbies || null,
        hometown: profileFormData.hometown || null
      });
      showNotification('信息更新成功！', 'success');
      fetchMemberDetail(selectedMemberDetail.member.id);
      setIsEditingProfile(false);
    } catch (err) {
      console.error('Failed to update member info', err);
      showNotification('更新失败', 'error');
    }
  };

  const executeAnalysis = async (memberId) => {
    try {
      setAnalysisLoading(true);
      setAnalysisResult('');
      setShowAnalysisNoteModal(false);
      setShowAnalysisModal(true);
      setShowAnalysisLoader(false);
      stopPolling();
      analysisAutoScroll.current = true;

      const response = await fetch(getFullApiUrl('/api/ai/analyze/member/stream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId, note: analysisNote || null })
      });

      if (!response.ok) {
        throw new Error('请求失败');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'content') {
                setAnalysisResult(prev => prev + data.content);
                if (analysisAutoScroll.current && analysisRef.current) {
                  analysisRef.current.scrollTop = analysisRef.current.scrollHeight;
                }
              } else if (data.type === 'error') {
                showNotification(data.content, 'error');
              }
            } catch (e) {
              // ignore parse errors
            }
          }
        }
      }
    } catch (err) {
      console.error('Failed to analyze', err);
      showNotification(err.message || '分析失败', 'error');
    } finally {
      setAnalysisLoading(false);
      setAnalysisNote('');
      setPendingAnalysisMemberId(null);
    }
  };

  const handleSaveNotice = async () => {
    if (!noticeForm.memberId || !noticeForm.content) {
      showNotification('请选择成员并填写通报内容', 'error');
      return;
    }
    try {
      setSavingNotice(true);
      await axios.post(getFullApiUrl('/api/notices'), {
        memberId: noticeForm.memberId,
        content: noticeForm.content,
        time: noticeForm.time,
        adminId: currentUser?.id || 'admin'
      });
      showNotification('通报添加成功！', 'success');
      setShowNoticeModal(false);
      setNoticeForm({
        memberId: '',
        content: '',
        time: new Date().toISOString().split('T')[0]
      });
      // 如果正在查看成员详情，刷新通报数据
      if (selectedMemberDetail?.member?.id) {
        fetchMemberDetail(selectedMemberDetail.member.id);
      }
    } catch (err) {
      console.error('Failed to save notice', err);
      showNotification('通报添加失败', 'error');
    } finally {
      setSavingNotice(false);
    }
  };

  const handleDeleteNotice = async (noticeId) => {
    try {
      await axios.delete(getFullApiUrl(`/api/notices/${noticeId}`));
      showNotification('通报删除成功！', 'success');
      // 刷新通报数据
      if (selectedMemberDetail?.member?.id) {
        fetchMemberDetail(selectedMemberDetail.member.id);
      }
    } catch (err) {
      console.error('Failed to delete notice', err);
      showNotification('通报删除失败', 'error');
    }
  };

  const downloadBackup = async () => {
    try {
      const res = await axios.get(getFullApiUrl('/api/download/scores'), {
        responseType: 'blob'
      });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `评分系统备份-${new Date().toISOString().split('T')[0]}.zip`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      showNotification('备份下载成功！', 'success');
      setShowMaintenanceModal(false);
    } catch (err) {
      console.error('Failed to download backup', err);
      showNotification('备份下载失败', 'error');
    }
  };

  const downloadBMIData = async () => {
    try {
      const sid = selectedSemesterId;
      const res = await axios.get(getFullApiUrl('/api/bmi/download'), {
        params: sid ? { semesterId: sid } : {},
        responseType: 'blob'
      });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `BMI数据-${new Date().toISOString().split('T')[0]}.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      showNotification('BMI数据下载成功！', 'success');
    } catch (err) {
      console.error('Failed to download BMI data', err);
      showNotification('BMI数据下载失败', 'error');
    }
  };

  const fetchBMIDisplayData = async (semesterId) => {
    try {
      const sid = semesterId || selectedSemesterId;
      const res = await axios.get(getFullApiUrl('/api/bmi/display'), {
        params: sid ? { semesterId: sid } : {}
      });
      setBmiDisplayData(res.data);
      setShowBMIDisplayModal(true);
    } catch (err) {
      console.error('Failed to fetch BMI display data', err);
      showNotification('获取BMI数据失败', 'error');
    }
  };

  const exportBMIToExcel = () => {
    if (!bmiDisplayData.weeks.length || !bmiDisplayData.members.length) {
      showNotification('暂无BMI数据可导出', 'error');
      return;
    }

    // 准备数据数组（用于创建基本工作表）
    const dataArray = [];

    // 添加表头
    const header = ['姓名', '班级'];
    bmiDisplayData.weeks.forEach(w => {
      header.push(`第${w.week}周 (${w.startDate}~${w.endDate})`);
    });
    dataArray.push(header);

    // 添加数据行
    bmiDisplayData.members.forEach(member => {
      const row = [member.name, member.class];
      bmiDisplayData.weeks.forEach(w => {
        const bmi = member.bmi[w.week];
        row.push(bmi !== undefined ? bmi : '');
      });
      dataArray.push(row);
    });

    // 添加及格标准说明
    dataArray.push([]);
    dataArray.push(['BMI及格标准']);
    dataArray.push(['男生：18.5 ~ 25.9']);
    dataArray.push(['女生：18.5 ~ 23.9']);
    dataArray.push(['红色单元格表示不及格的BMI数据']);

    // 创建工作表
    const worksheet = XLSX.utils.aoa_to_sheet(dataArray);

    // 为表头添加样式
    const headerRowRef = XLSX.utils.encode_row(0);
    for (let c = 0; c < header.length; c++) {
      const cellRef = XLSX.utils.encode_cell({ r: 0, c: c });
      if (worksheet[cellRef]) {
        worksheet[cellRef].s = {
          font: { bold: true },
          fill: { fgColor: { rgb: 'E0E0E0' } },
          alignment: { horizontal: 'center' }
        };
      }
    }

    // 为数据行添加样式
    bmiDisplayData.members.forEach((member, rowIndex) => {
      const isFemale = isFemaleMember(member.id); // 女班学员
      bmiDisplayData.weeks.forEach((w, colIndex) => {
        const bmi = member.bmi[w.week];
        const isPass = bmi !== undefined && bmi >= 18.5 && bmi <= (isFemale ? 23.9 : 25.9);
        
        if (bmi !== undefined && !isPass) {
          const cellRef = XLSX.utils.encode_cell({ r: rowIndex + 1, c: colIndex + 2 }); // +1 for header row, +2 for name and class columns
          if (worksheet[cellRef]) {
            worksheet[cellRef].s = {
              fill: { fgColor: { rgb: 'FFC0C0' } },
              font: { color: { rgb: 'FF0000' }, bold: true }
            };
          }
        }
      });
    });

    // 设置列宽
    worksheet['!cols'] = [
      { wch: 10 },  // 姓名
      { wch: 15 },  // 班级
      ...bmiDisplayData.weeks.map(() => ({ wch: 20 }))  // 周次数据列
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'BMI数据');

    // 下载文件
    XLSX.writeFile(workbook, `BMI数据一览-${new Date().toISOString().split('T')[0]}.xlsx`);
    showNotification('BMI数据导出成功！', 'success');
  };

  const updateWeek = async () => {
    const week = parseInt(weekInput);
    if (!week || week < 1) {
      showNotification('请输入有效的周次（大于0）', 'error');
      return;
    }
    try {
      const res = await axios.post(getFullApiUrl('/api/config/update-week'), { week });
      fetchConfig();
      showNotification(res.data.message, 'success');
      setWeekInput('');
      setShowMaintenanceModal(false);
    } catch (err) {
      console.error('Failed to update week', err);
      showNotification(err.response?.data?.error || '周次更新失败', 'error');
    }
  };

  // 保存学期配置（起点日期）
  const saveSemesters = async () => {
    const semesters = (config.semesters || []).map(s => {
      const raw = semesterEditMap[s.id] || s.startDate;
      // 日期输入框只给 YYYY-MM-DD，补齐北京时区，避免 new Date 解析成 UTC 导致周次偏移 8 小时
      const startDate = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00+08:00` : raw;
      return { id: s.id, name: s.name, startDate };
    });
    try {
      const res = await axios.post(getFullApiUrl('/api/config/update-semesters'), {
        semesters,
        currentSemesterId: config.currentSemesterId,
      });
      setConfig({ ...config, semesters: res.data.semesters, currentSemesterId: res.data.currentSemesterId, currentWeek: res.data.currentWeek });
      setSemesterEditMap({});
      showNotification('学期配置已保存', 'success');
    } catch (err) {
      console.error('Failed to save semesters', err);
      showNotification(err.response?.data?.error || '学期配置保存失败', 'error');
    }
  };

  // 切换当前学期
  const switchSemester = async (semesterId) => {
    try {
      const res = await axios.post(getFullApiUrl('/api/config/update-semesters'), {
        currentSemesterId: semesterId,
      });
      setConfig({ ...config, currentSemesterId: res.data.currentSemesterId, currentWeek: res.data.currentWeek });
      setSelectedSemesterId(semesterId);
      setSelectedWeek(res.data.currentWeek);
      setSelectedRadarWeek(null);
      setSelectedRadarMember(null);
      fetchEntropyWeights(semesterId);
      showNotification(`已切换到第${semesterId}学期`, 'success');
      fetchConfig();
    } catch (err) {
      console.error('Failed to switch semester', err);
      showNotification(err.response?.data?.error || '学期切换失败', 'error');
    }
  };

  // 添加新学期（自动生成下一个学期名与默认起点日期）
  const addSemester = () => {
    const semesters = config.semesters || [];
    const maxId = semesters.reduce((m, s) => Math.max(m, Number(s.id) || 0), 0);
    const newId = maxId + 1;
    const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八'];
    const grade = Math.floor((newId - 1) / 2) + 1;
    const half = (newId - 1) % 2 === 0 ? '上' : '下';
    const name = `大${CN_NUM[grade - 1] || grade}${half}`;
    // 默认起点：上一学期起点往后顺延 182 天（约一学期）
    let startDate = '';
    const last = semesters[semesters.length - 1];
    if (last && last.startDate) {
      const d = new Date(last.startDate);
      d.setDate(d.getDate() + 182);
      startDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    setConfig({ ...config, semesters: [...semesters, { id: newId, name, startDate }] });
    setSemesterEditMap(prev => ({ ...prev, [newId]: startDate }));
  };

  // 删除学期（仅从配置移除，不删磁盘上的评分数据文件；删除当前学期时自动切到第一个）
  const deleteSemester = async (semesterId) => {
    const semesters = (config.semesters || []).filter(s => Number(s.id) !== Number(semesterId));
    if (semesters.length === 0) {
      showNotification('至少保留一个学期', 'error');
      return;
    }
    if (typeof window !== 'undefined' && !window.confirm('确定删除该学期吗？该学期评分数据文件将保留但不再显示。')) return;
    let currentSemesterId = config.currentSemesterId;
    if (Number(currentSemesterId) === Number(semesterId)) {
      currentSemesterId = semesters[0].id;
    }
    try {
      const res = await axios.post(getFullApiUrl('/api/config/update-semesters'), {
        semesters,
        currentSemesterId,
      });
      setConfig({ ...config, semesters: res.data.semesters, currentSemesterId: res.data.currentSemesterId, currentWeek: res.data.currentWeek });
      setSelectedSemesterId(res.data.currentSemesterId);
      setSemesterEditMap({});
      showNotification('学期已删除', 'success');
      fetchConfig();
    } catch (err) {
      console.error('Failed to delete semester', err);
      showNotification(err.response?.data?.error || '学期删除失败', 'error');
    }
  };

  const handleRankUpload = async () => {
    if (!rankUploadFile) {
      showNotification('请选择文件', 'error');
      return;
    }
    setRankUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', rankUploadFile);
      const res = await axios.post(getFullApiUrl('/api/upload/rank-scores'), formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      });
      showNotification(`成功导入 ${res.data.count} 条成绩排名！`, 'success');
      setShowRankUploadModal(false);
      setRankUploadFile(null);
      if (selectedMemberDetail?.member?.id) {
        fetchMemberDetail(selectedMemberDetail.member.id);
      }
    } catch (err) {
      console.error('Upload failed', err);
      showNotification(err.response?.data?.error || '上传失败', 'error');
    } finally {
      setRankUploading(false);
    }
  };

  const handleFileUpload = async () => {
    if (!uploadFile) {
      showNotification('请选择文件', 'error');
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', uploadFile);
      if (uploadType === 'fitness') {
        formData.append('month', fitnessMonth);
      }
      const endpoint = uploadType === 'academic' ? '/api/upload/academic-scores' : '/api/upload/fitness-scores';
      const res = await axios.post(getFullApiUrl(endpoint), formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      });
      showNotification(`成功导入 ${res.data.count} 条${uploadType === 'academic' ? '成绩' : '体能'}！`, 'success');
      setShowUploadModal(false);
      setUploadFile(null);
      if (selectedMemberDetail?.member?.id) {
        fetchMemberDetail(selectedMemberDetail.member.id);
      }
    } catch (err) {
      console.error('Upload failed', err);
      showNotification(err.response?.data?.error || '上传失败', 'error');
    } finally {
      setUploading(false);
    }
  };

  // 上传每周通报
  const handleWeeklyReportUpload = async () => {
    if (!weeklyReportFile) {
      showNotification('请选择文件', 'error');
      return;
    }
    setWeeklyReportLoading(true);
    try {
      const formData = new FormData();
      formData.append('file', weeklyReportFile);
      const res = await axios.post(getFullApiUrl('/api/weekly-reports/upload'), formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setWeeklyReportResult(res.data);
      showNotification(res.data.message, 'success');
    } catch (err) {
      showNotification(err.response?.data?.error || '上传失败', 'error');
    } finally {
      setWeeklyReportLoading(false);
    }
  };

  // 纠正模糊匹配
  const handleCorrectFuzzyMatch = async (weekRange, fromName, toName, toMemberId) => {
    try {
      const res = await axios.put(getFullApiUrl(`/api/weekly-reports/${encodeURIComponent(weekRange)}/correct-member`), {
        fromName, toName, toMemberId
      });
      // 用纠正后的数据刷新结果
      setWeeklyReportResult(prev => ({
        ...prev,
        message: res.data.message,
        reportText: res.data.report.reportText,
        memberScores: res.data.report.memberScores,
        fuzzyMatches: (prev.fuzzyMatches || []).filter(fm => fm.original !== fromName)
      }));
      showNotification(res.data.message, 'success');
    } catch (err) {
      showNotification(err.response?.data?.error || '纠正失败', 'error');
    }
  };

  // 加载可用周次列表并打开查看弹窗
  const openWeeklyReportViewer = async () => {
    try {
      const res = await axios.get(getFullApiUrl('/api/weekly-reports'));
      setWeeklyReportsList(res.data);
      setWeeklyReportDetail(null);
      setShowWeeklyReportViewer(true);
    } catch (err) {
      showNotification('加载失败', 'error');
    }
  };

  // 查看指定周次详情
  const fetchWeeklyReportDetail = async (weekRange) => {
    try {
      const res = await axios.get(getFullApiUrl(`/api/weekly-reports/${encodeURIComponent(weekRange)}`));
      setWeeklyReportDetail(res.data);
    } catch (err) {
      showNotification('加载详情失败', 'error');
    }
  };

  const getRadarOption = (weekData, prevWeekData) => {
    const data = dimensions.map(d => weekData.averages[d.key]);
    const prevData = prevWeekData ? dimensions.map(d => prevWeekData.averages[d.key]) : null;
    
    // 计算加权综合得分（10分制转百分制）
    let totalScore = 0;
    let totalWeight = 0;
    dimensions.forEach(d => {
      const score = weekData.averages[d.key];
      if (score !== undefined && score !== null) {
        totalScore += score * entropyWeights[d.key];
        totalWeight += entropyWeights[d.key];
      }
    });
    const finalScore = totalWeight > 0 ? Math.round((totalScore / totalWeight) * 10) : 0;
    
    const series = [
      {
        name: '本周得分',
        type: 'radar',
        data: [
          {
            value: data,
            name: '本周',
            areaStyle: {
              color: 'rgba(59, 130, 246, 0.5)'
            },
            lineStyle: {
              width: 2,
              color: '#3b82f6'
            },
            symbol: 'circle',
            symbolSize: 6
          }
        ]
      }
    ];
    
    if (prevData) {
      series.push({
        name: '上周得分',
        type: 'radar',
        data: [
          {
            value: prevData,
            name: '上周',
            areaStyle: {
              color: 'rgba(156, 163, 175, 0.2)'
            },
            lineStyle: {
              width: 2,
              color: '#9ca3af',
              type: 'dashed'
            },
            symbol: 'circle',
            symbolSize: 4
          }
        ]
      });
    }
    
    return {
      title: {
        text: `第 ${weekData.week} 周评分图 · ${finalScore}分`,
        left: 'center',
        textStyle: { fontSize: 14 }
      },
      tooltip: {
        show: false
      },
      legend: prevData ? {
        show: true,
        bottom: 0,
        data: ['本周', '上周'],
        textStyle: {
          fontSize: 10
        }
      } : { show: false },
      radar: {
        indicator: dimensions.map(d => ({ name: d.label, max: 10 })),
        radius: prevData ? '55%' : '65%',
        name: {
          textStyle: {
            color: '#6b7280',
            fontSize: 10
          }
        }
      },
      series
    };
  };

  const getScoreLineChartOption = (semesterScores) => {
    if (!semesterScores || semesterScores.length === 0) return null;
    
    // 过滤掉"总"学期，只保留实际学期并排序
    const validScores = semesterScores.filter(s => s.semester !== '总');
    if (validScores.length === 0) return null;
    
    const sortedScores = [...validScores].sort((a, b) => {
      const semA = a.semester || '';
      const semB = b.semester || '';
      return semA.localeCompare(semB);
    });

    return {
      title: {
        text: '成绩随学期变化',
        left: 'center',
        textStyle: { fontSize: 14 }
      },
      tooltip: {
        trigger: 'axis',
        formatter: (params) => {
          const param = params[0];
          return `${param.axisValue}<br/>平均成绩: ${param.value}分`;
        }
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '3%',
        containLabel: true
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: sortedScores.map(s => s.semester),
        axisLabel: {
          fontSize: 10
        }
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        axisLabel: {
          fontSize: 10
        }
      },
      series: [
        {
          name: '平均成绩',
          type: 'line',
          data: sortedScores.map(s => s.score),
          smooth: true,
          areaStyle: {
            color: 'rgba(59, 130, 246, 0.2)'
          },
          lineStyle: {
            width: 2,
            color: '#3b82f6'
          },
          itemStyle: {
            color: '#3b82f6'
          },
          symbol: 'circle',
          symbolSize: 8
        }
      ]
    };
  };

  const getRankLineChartOption = (semesterScores) => {
    if (!semesterScores || semesterScores.length === 0) return null;
    
    // 过滤掉"总"学期，只保留实际学期并排序
    const validScores = semesterScores.filter(s => s.semester !== '总');
    if (validScores.length === 0) return null;
    
    const sortedScores = [...validScores].sort((a, b) => {
      const semA = a.semester || '';
      const semB = b.semester || '';
      return semA.localeCompare(semB);
    });

    // 找出最大排名值用于设置y轴
    const maxRank = Math.max(...sortedScores.map(s => s.rank || 0));

    return {
      title: {
        text: '排名随学期变化',
        left: 'center',
        textStyle: { fontSize: 14 }
      },
      tooltip: {
        trigger: 'axis',
        formatter: (params) => {
          const param = params[0];
          return `${param.axisValue}<br/>排名: 第${param.value}名`;
        }
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '3%',
        containLabel: true
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: sortedScores.map(s => s.semester),
        axisLabel: {
          fontSize: 10
        }
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: maxRank + 10,
        axisLabel: {
          fontSize: 10,
          formatter: (value) => `第${value}名`
        },
        inverse: true
      },
      series: [
        {
          name: '排名',
          type: 'line',
          data: sortedScores.map(s => s.rank),
          smooth: true,
          areaStyle: {
            color: 'rgba(139, 92, 246, 0.2)'
          },
          lineStyle: {
            width: 2,
            color: '#8b5cf6'
          },
          itemStyle: {
            color: '#8b5cf6'
          },
          symbol: 'circle',
          symbolSize: 8
        }
      ]
    };
  };

  const getFitnessLineChartOption = (itemName, history, isFemale, heightFromFitness, weightFromFitness) => {
    if (!history || history.length === 0) return null;
    
    // 按月份排序
    const sortedHistory = [...history].sort((a, b) => a.month.localeCompare(b.month));
    
    // BMI及格范围
    const minBMI = 18.5;
    const maxBMI = isFemale ? 23.9 : 25.9;
    
    // 获取及格标准
    const standards = {
      '三千米': { male: 13 * 60 + 35, female: 16 * 60 + 5, isTime: true, unit: '秒' },
      '3000米': { male: 13 * 60 + 35, female: 16 * 60 + 5, isTime: true, unit: '秒' },
      '仰卧卷腹': { male: 35, female: 27, isTime: false, unit: '个' },
      '蛇形跑': { male: 20.4, female: 22.2, isTime: true, unit: '秒' },
      '曲臂悬垂': { male: 11, female: 36, isTime: false, unit: '秒' },
      '单杠': { male: 11, female: 36, isTime: false, unit: '个' },
      '曲臂悬垂/单杠': { male: 11, female: 36, isTime: false, unit: '个' },
      'BMI': { isBMI: true }
    };
    
    // 标准化项目名称
    let standardItemName = itemName;
    if (itemName === '屈臂悬垂' || itemName === '曲臂悬垂' || itemName === '单杠' || itemName === '引体向上' || itemName === '屈臂悬垂/单杠' || itemName === '曲臂悬垂/单杠' || itemName === '单杠/引体向上') {
      standardItemName = '曲臂悬垂/单杠';
    } else if (itemName === '3000米') {
      standardItemName = '三千米';
    }
    
    const standard = standards[standardItemName];
    const passValue = standard ? (standard.isBMI ? null : (isFemale ? standard.female : standard.male)) : null;
    
    // 处理数据，转换为可比较的数值（保留所有月份，即使未参考）
    const data = sortedHistory.map((h, index) => {
      const score = h.scores[itemName];
      let numericValue = null;
      let displayScore = score;
      
      // 如果是BMI项目，从该月份的体测数据中获取身高体重来计算
      if (itemName === 'BMI') {
        const hValue = h.scores['身高'];
        const wValue = h.scores['体重'];
        if (hValue && wValue) {
          let height = parseFloat(hValue);
          let weight = parseFloat(wValue);
          
          // 处理身高可能是米为单位的情况（小于3米时，转换为厘米）
          if (!isNaN(height) && height > 0 && height < 3) {
            height = height * 100;
          }
          
          if (!isNaN(height) && !isNaN(weight) && height > 0 && weight > 0) {
            const heightInMeters = height / 100;
            const calculatedBMI = weight / (heightInMeters * heightInMeters);
            numericValue = Math.round(calculatedBMI * 10) / 10;
            displayScore = numericValue;
          }
        }
      } else if (standard && standardItemName === '三千米') {
        numericValue = parseThreeKilometerTime(score);
      } else if (standard && standardItemName === '蛇形跑') {
        numericValue = parseSnakeRunTime(score);
      } else if (score !== null && score !== undefined && score !== '') {
        const scoreStr = String(score).trim();
        if (scoreStr !== '未参考') {
          let num = parseFloat(scoreStr);
          if (!isNaN(num)) {
            // 处理身高单位转换：如果值小于3，认为是米，转换为厘米
            if (itemName === '身高' && num > 0 && num < 3) {
              num = num * 100;
            }
            numericValue = num;
          }
        }
      }
      
      return {
        month: h.month,
        score: displayScore,
        value: numericValue,
        isUnreference: numericValue === null
      };
    });
    
    // 准备数据
    const months = data.map(d => d.month);
    const values = data.map(d => d.value);
    const validValues = values.filter(v => v !== null);
    
    // 找出最大最小值用于设置y轴
    let minVal = 0, maxVal = 100, padding = 10;
    if (standard && standard.isBMI) {
      // BMI：使用固定范围
      if (validValues.length > 0) {
        minVal = Math.min(...validValues, minBMI - 2);
        maxVal = Math.max(...validValues, maxBMI + 2);
        padding = 1;
      } else {
        minVal = minBMI - 5;
        maxVal = maxBMI + 5;
        padding = 1;
      }
    } else {
      if (validValues.length > 0) {
        minVal = Math.min(...validValues, passValue !== null ? passValue : Infinity);
        maxVal = Math.max(...validValues, passValue !== null ? passValue : -Infinity);
        padding = (maxVal - minVal) * 0.2 || 1;
        
        // 确保padding有合理值
        if (padding < 5) padding = 5;
      } else if (passValue !== null) {
        minVal = passValue - 30;
        maxVal = passValue + 30;
        padding = 10;
      }
    }
    
    // y轴标签格式化函数
    const formatYAxisLabel = (value) => {
      if (standardItemName === '三千米' || standardItemName === '3000米') {
        // 三千米：将秒数格式化为分钟'秒"
        const minutes = Math.floor(value / 60);
        const seconds = Math.round(value % 60);
        return `${minutes}'${String(seconds).padStart(2, '0')}"`;
      } else if (standardItemName === '蛇形跑') {
        // 蛇形跑：保留一位小数
        return value.toFixed(1);
      }
      return value;
    };
    
    // 准备系列数据：一个系列显示所有数据，每个数据点带itemStyle
    const seriesData = values.map((v, i) => {
      if (v === null) return null;
      
      let itemColor = '#10b981'; // 默认绿色（及格）
      if (standard) {
        let isPass = false;
        if (standard.isBMI) {
          // BMI：在范围内为及格
          isPass = v >= minBMI && v <= maxBMI;
        } else if (passValue !== null) {
          if (standard.isTime) {
            isPass = v <= passValue;
          } else {
            isPass = v >= passValue;
          }
        }
        if (!isPass) {
          itemColor = '#ef4444'; // 红色（不及格）
        }
      }
      
      return {
        value: v,
        itemStyle: {
          color: itemColor
        }
      };
    });
    
    const option = {
      title: {
        text: `${itemName} 成绩变化`,
        left: 'center',
        textStyle: { fontSize: 14 }
      },
      tooltip: {
        trigger: 'axis',
        formatter: (params) => {
          const param = params.find(p => p.value !== null) || params[0];
          const dataIndex = param?.dataIndex ?? 0;
          const originalData = data[dataIndex];
          let result = `${originalData.month}<br/>`;
          if (originalData.isUnreference) {
            result += `${itemName}: 未参考`;
          } else {
            result += `${itemName}: ${formatFitnessScore(itemName, originalData.score)}`;
            if (standard) {
              let isPass = false;
              if (standard.isBMI) {
                // BMI：在范围内为及格
                isPass = originalData.value >= minBMI && originalData.value <= maxBMI;
              } else if (passValue !== null) {
                if (standard.isTime) {
                  isPass = originalData.value <= passValue;
                } else {
                  isPass = originalData.value >= passValue;
                }
              }
              result += `<br/><span style="color: ${isPass ? '#10b981' : '#ef4444'};">${isPass ? '✓ 及格' : '✗ 不及格'}</span>`;
            }
          }
          return result;
        }
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '3%',
        containLabel: true
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: months,
        axisLabel: {
          fontSize: 10
        }
      },
      yAxis: {
        type: 'value',
        min: minVal - padding,
        max: maxVal + padding,
        axisLabel: {
          fontSize: 10,
          formatter: formatYAxisLabel
        }
      },
      series: []
    };
    
    // 添加及格线
    if (standard) {
      if (standard.isBMI) {
        // BMI：添加两条及格线（最小值和最大值）
        option.series.push({
          name: '及格范围下限',
          type: 'line',
          data: new Array(months.length).fill(minBMI),
          lineStyle: {
            type: 'dashed',
            color: '#10b981',
            width: 2
          },
          itemStyle: {
            show: false
          },
          symbol: 'none'
        });
        option.series.push({
          name: '及格范围上限',
          type: 'line',
          data: new Array(months.length).fill(maxBMI),
          lineStyle: {
            type: 'dashed',
            color: '#10b981',
            width: 2
          },
          itemStyle: {
            show: false
          },
          symbol: 'none'
        });
      } else if (passValue !== null) {
        option.series.push({
          name: '及格线',
          type: 'line',
          data: new Array(months.length).fill(passValue),
          lineStyle: {
            type: 'dashed',
            color: '#f59e0b',
            width: 2
          },
          itemStyle: {
            show: false
          },
          symbol: 'none'
        });
      }
    }
    
    // 添加成绩数据（一个系列，数据点颜色根据及格/不及格设置）
    option.series.push({
      name: '成绩',
      type: 'line',
      data: seriesData,
      smooth: true,
      connectNulls: true,
      lineStyle: {
        width: 3,
        color: '#3b82f6'
      },
      symbol: 'circle',
      symbolSize: 8
    });
    
    return option;
  };

  const getBMILineChartOption = (memberBMIData, isFemale) => {
    if (!memberBMIData || memberBMIData.length === 0) return null;

    // 按周次排序
    const sortedData = [...memberBMIData].sort((a, b) => a.week - b.week);

    // BMI及格范围
    const minBMI = 18.5;
    const maxBMI = isFemale ? 23.9 : 25.9;

    // 准备数据
    const weeks = sortedData.map(d => `第${d.week}周`);
    const values = sortedData.map(d => d.bmi);

    // 找出最大最小值用于设置y轴
    const minVal = Math.min(...values, minBMI - 2);
    const maxVal = Math.max(...values, maxBMI + 2);
    const padding = 1;

    // 准备系列数据：每个数据点带itemStyle
    const seriesData = values.map((v, i) => {
      let itemColor = '#10b981'; // 默认绿色（及格）
      const isPass = v >= minBMI && v <= maxBMI;
      if (!isPass) {
        itemColor = '#ef4444'; // 红色（不及格）
      }

      return {
        value: v,
        itemStyle: {
          color: itemColor
        }
      };
    });

    const option = {
      title: {
        text: 'BMI 变化趋势（录入数据）',
        left: 'center',
        textStyle: { fontSize: 14 }
      },
      tooltip: {
        trigger: 'axis',
        formatter: (params) => {
          const param = params.find(p => p.value !== null) || params[0];
          const dataIndex = param?.dataIndex ?? 0;
          const originalData = sortedData[dataIndex];
          const isPass = originalData.bmi >= minBMI && originalData.bmi <= maxBMI;
          const weekLabel = originalData.dateRange 
            ? `第${originalData.week}周 (${originalData.weekStart}-${originalData.weekEnd})`
            : `第${originalData.week}周`;
          let result = `${weekLabel}<br/>`;
          result += `BMI: ${originalData.bmi.toFixed(1)}`;
          result += `<br/><span style="color: ${isPass ? '#10b981' : '#ef4444'};">${isPass ? '✓ 及格' : '✗ 不及格'}</span>`;
          return result;
        }
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '3%',
        containLabel: true
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: sortedData.map(d => d.dateRange ? `${d.dateRange}` : `第${d.week}周`),
        axisLabel: {
          fontSize: 10
        }
      },
      yAxis: {
        type: 'value',
        min: minVal - padding,
        max: maxVal + padding,
        axisLabel: {
          fontSize: 10
        }
      },
      series: []
    };

    // 添加两条及格线（最小值和最大值）
    option.series.push({
      name: '及格范围下限',
      type: 'line',
      data: new Array(weeks.length).fill(minBMI),
      lineStyle: {
        type: 'dashed',
        color: '#10b981',
        width: 2
      },
      itemStyle: {
        show: false
      },
      symbol: 'none'
    });
    option.series.push({
      name: '及格范围上限',
      type: 'line',
      data: new Array(weeks.length).fill(maxBMI),
      lineStyle: {
        type: 'dashed',
        color: '#10b981',
        width: 2
      },
      itemStyle: {
        show: false
      },
      symbol: 'none'
    });

    // 添加BMI数据
    option.series.push({
      name: 'BMI',
      type: 'line',
      data: seriesData,
      smooth: true,
      connectNulls: true,
      lineStyle: {
        width: 3,
        color: '#3b82f6'
      },
      symbol: 'circle',
      symbolSize: 8
    });

    return option;
  };


  // 防御性保护：若 view 已进入非 login 视图但 currentUser 丢失，回退到登录页避免白屏
  useEffect(() => {
    if (view !== 'login' && view !== 'play' && !currentUser) {
      console.warn('[App] view=', view, '但 currentUser 为空，回退到登录页')
      setView('login')
    }
  }, [view, currentUser])

  if (view !== 'login' && view !== 'play' && !currentUser) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="text-gray-500">加载中...</div>
      </div>
    )
  }

  if (isPlayModeLoading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-80">
        <div className="bg-white rounded-2xl p-8 max-w-md w-full flex flex-col items-center">
          <div className="w-16 h-16 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mb-6"></div>
          <h3 className="text-xl font-bold text-gray-900 mb-2">正在加载播放模式</h3>
          <p className="text-gray-600 text-center mb-4">
            正在收集数据，请稍候...
          </p>
          <p className="text-sm text-gray-500 text-center">
            可能需要等待3-5秒
          </p>
        </div>
      </div>
    );
  }

  if (view === 'login') {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        {/* Notification */}
        {notification.show && (
          <div className={`fixed top-4 left-1/2 transform -translate-x-1/2 z-[9999] px-6 py-3 rounded-xl shadow-lg transition-all duration-300 ${
            notification.type === 'success' ? 'bg-green-500 text-white' : 'bg-red-500 text-white'
          }`}>
            {notification.message}
            </div>
          )}
        
        {/* Update Modal */}
        {showUpdateModal && updateInfo && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-70">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
              <div className="p-6">
                <div className="text-center mb-6">
                  <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg className="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </div>
                  <h2 className="text-xl font-bold text-gray-900 mb-2">发现新版本</h2>
                  <p className="text-gray-600">
                    版本 {updateInfo.version} (版本代码: {updateInfo.versionCode})
                  </p>
                </div>
                
                {updateInfo.releaseNotes && (
                  <div className="mb-6">
                    <h3 className="text-sm font-semibold text-gray-700 mb-2">更新内容:</h3>
                    <div className="bg-gray-50 rounded-lg p-4">
                      <p className="text-sm text-gray-600 whitespace-pre-wrap">{updateInfo.releaseNotes}</p>
                    </div>
                  </div>
                )}

                {updateInfo.updateRequired && (
                  <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
                    <p className="text-red-700 text-sm font-medium">
                      ⚠️ 本次更新为强制更新，必须更新后才能继续使用
                    </p>
                  </div>
                )}

                <div className="space-y-3">
                  <button
                    onClick={downloadAndInstallUpdate}
                    disabled={downloadingUpdate}
                    className="w-full px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {downloadingUpdate ? (
                      <>
                        <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                        下载中...
                      </>
                    ) : (
                      '下载并安装'
                    )}
                  </button>
                  
                  {!updateInfo.updateRequired && (
                    <button
                      onClick={handleRemindLater}
                      className="w-full px-4 py-3 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                    >
                      稍后再说
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
        {/* 注意事项弹窗 */}
        {showDisclaimerModal && (
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black bg-opacity-70">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[85vh] overflow-hidden flex flex-col">
              {/* 标题 */}
              <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white p-4">
                <h2 className="text-xl font-bold text-center">"智慧家园"评分信息统计程序</h2>
                <p className="text-center text-blue-100 text-sm mt-1">使用前注意事项</p>
              </div>
              
              {/* 内容 */}
              <div className="flex-1 overflow-y-auto p-4">
                <div className="space-y-3 text-gray-700 text-sm">
                  <div className="bg-gray-50 p-3 rounded-lg border-l-4 border-blue-500">
                    <p className="leading-relaxed">
                      1、本程序统计的所有人员信息属于内部敏感涉密信息，使用者必须严格遵守"保密条例"、微信使用"十不准"等相关保密法律法规，坚守保密底线，绝不允许以任何形式、传播、拷贝信息内容。
                    </p>
                  </div>
                  
                  <div className="bg-gray-50 p-3 rounded-lg border-l-4 border-green-500">
                    <p className="leading-relaxed">
                      2、首次使用需通过完成账号注册，登录密码需符合密码设置规范，严禁使用简单密码、通用密码，妥善保管账号登录凭证。
                    </p>
                  </div>
                  
                  <div className="bg-gray-50 p-3 rounded-lg border-l-4 border-yellow-500">
                    <p className="leading-relaxed">
                      3、使用前务必熟悉程序操作流程、信息填报标准，确保信息真实、准确、完整，严禁虚报、瞒报、漏报、篡改人员信息。
                    </p>
                  </div>
                  
                  <div className="bg-gray-50 p-3 rounded-lg border-l-4 border-red-500">
                    <p className="leading-relaxed">
                      4、所有使用者需对本人操作行为全程负责，若出现违反保密纪律、越权操作、泄露信息、违规使用设备等行为，将严格按照纪律条例及相关法律法规追究责任。
                    </p>
                  </div>
                </div>
                
                {/* 复选框 */}
                <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={disclaimerAgreed}
                      onChange={(e) => setDisclaimerAgreed(e.target.checked)}
                      className="mt-0.5 w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                    />
                    <span className="text-gray-700 text-sm">
                      我已仔细阅读注意事项并同意遵守相关规定
                    </span>
                  </label>
                </div>
                
                {/* 倒计时 */}
                <div className="mt-3 text-center">
                  <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-gray-100 rounded-full text-sm">
                    <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span className="text-gray-600">
                      请等待 <span className="text-blue-600 font-bold">{countdownSeconds}</span> 秒后可滑动确认
                    </span>
                  </div>
                </div>
                
                {/* 滑动确认 */}
                <div className="mt-4">
                  <div 
                    className="relative bg-gray-200 rounded-full h-10 overflow-hidden cursor-pointer select-none"
                    onMouseDown={(e) => {
                      if (countdownSeconds > 0 || !disclaimerAgreed) return;
                      e.preventDefault();
                      const startX = e.clientX;
                      const rect = e.currentTarget.getBoundingClientRect();
                      const maxPos = rect.width - 44;
                      let currentPos = slidePosition;
                      
                      const handleMouseMove = (moveEvent) => {
                        const currentX = moveEvent.clientX;
                        const deltaX = currentX - startX;
                        currentPos = Math.max(0, Math.min(maxPos, deltaX + slidePosition));
                        setSlidePosition(currentPos);
                      };
                      
                      const handleMouseUp = () => {
                        document.removeEventListener('mousemove', handleMouseMove);
                        document.removeEventListener('mouseup', handleMouseUp);
                        
                        if (currentPos >= maxPos * 0.9 && countdownSeconds === 0 && disclaimerAgreed) {
                          setShowDisclaimerModal(false);
                          setDisclaimerAgreed(false);
                          setCountdownSeconds(2);
                          setSlidePosition(0);
                        } else {
                          setSlidePosition(0);
                        }
                      };
                      
                      document.addEventListener('mousemove', handleMouseMove);
                      document.addEventListener('mouseup', handleMouseUp);
                    }}
                    onTouchStart={(e) => {
                      if (countdownSeconds > 0 || !disclaimerAgreed) return;
                      e.preventDefault();
                      const startX = e.touches[0].clientX;
                      const rect = e.currentTarget.getBoundingClientRect();
                      const maxPos = rect.width - 44;
                      let currentPos = slidePosition;
                      
                      const handleTouchMove = (moveEvent) => {
                        const currentX = moveEvent.touches[0].clientX;
                        const deltaX = currentX - startX;
                        currentPos = Math.max(0, Math.min(maxPos, deltaX + slidePosition));
                        setSlidePosition(currentPos);
                      };
                      
                      const handleTouchEnd = () => {
                        document.removeEventListener('touchmove', handleTouchMove);
                        document.removeEventListener('touchend', handleTouchEnd);
                        
                        if (currentPos >= maxPos * 0.9 && countdownSeconds === 0 && disclaimerAgreed) {
                          setShowDisclaimerModal(false);
                          setDisclaimerAgreed(false);
                          setCountdownSeconds(2);
                          setSlidePosition(0);
                        } else {
                          setSlidePosition(0);
                        }
                      };
                      
                      document.addEventListener('touchmove', handleTouchMove);
                      document.addEventListener('touchend', handleTouchEnd);
                    }}
                  >
                    <div 
                      className="absolute inset-y-1 left-1 bg-blue-500 rounded-full transition-all duration-75"
                      style={{ width: `calc(${slidePosition}px + 42px)` }}
                    ></div>
                    <div 
                      className="absolute inset-y-1 left-1 w-8 bg-white rounded-full shadow-lg flex items-center justify-center"
                      style={{ left: `${slidePosition}px` }}
                    >
                      <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </div>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className={`font-medium text-sm ${slidePosition > 30 ? 'text-white' : 'text-gray-500'}`}>
                        {countdownSeconds > 0 ? '请等待倒计时结束' : !disclaimerAgreed ? '请勾选同意协议' : '滑动确认 →'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
        
        <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
          <h1 className="text-3xl font-bold text-center text-blue-600 mb-8">班级评分系统</h1>
          
          {/* 更新公告 */}
          <div className="mb-8 p-4 bg-blue-50 border border-blue-100 rounded-xl">
            <h3 className="text-lg font-bold text-blue-700 mb-2 flex items-center gap-2">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              更新公告
            </h3>
            <div className="text-sm text-gray-700 space-y-2">
              {(updateNotices?.updateNotice || '').split('\n').map((line, index) => (
                line.trim() && <p key={index}>{line}</p>
              ))}
              {updateNotices.downloadLink && (
                <p>本系统已推出安卓版本应用，点击此链接下载（在浏览器中打开）：
                  <a 
                    href={updateNotices.downloadLink} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:text-blue-800 underline ml-1"
                  >
                    {updateNotices.downloadLink}
                  </a>
                </p>
              )}
            </div>
            {updateNotices.contact && <p className="text-xs text-gray-500 mt-3">{updateNotices.contact}</p>}
          </div>
          
          {/* 连接微信 */}
          {wechatStatus !== null && (
            <div className="mb-8 p-4 border rounded-xl">
              <button
                onClick={() => setShowWechatConnect(!showWechatConnect)}
                className="w-full flex items-center justify-between"
              >
                <div className="flex items-center gap-2">
                  <svg className="w-5 h-5 text-green-500" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.046.246.246 0 0 0 .242-.246c0-.06-.024-.12-.04-.178l-.325-1.233a.492.492 0 0 1 .178-.553C23.028 18.333 24 16.592 24 14.628c0-3.299-3.063-5.77-7.062-5.77zm-2.18 3.452c.535 0 .969.44.969.983a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.983.97-.983zm4.844 0c.535 0 .969.44.969.983a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.983.97-.983z"/>
                  </svg>
                  <span className="font-medium text-gray-700">连接微信</span>
                  {wechatStatus?.online > 0 && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-100 text-green-700 text-xs font-medium rounded-full">
                      <span className="w-1.5 h-1.5 bg-green-500 rounded-full"></span>
                      {wechatStatus.online} Bot在线
                    </span>
                  )}
                </div>
                <svg className={`w-5 h-5 text-gray-400 transition-transform ${showWechatConnect ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              
              {showWechatConnect && (
                <div className="mt-4 space-y-4">
                  {wechatMode === null && (
                    <div className="space-y-2">
                      <button
                        onClick={() => {
                          setWechatMode('admin');
                          setSelectedClass('');
                          setWechatBindMemberId('');
                          setWechatBindStep('idle');
                        }}
                        className="w-full flex items-center justify-between p-3 border border-gray-200 rounded-xl hover:bg-blue-50 hover:border-blue-300 transition-all"
                      >
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 bg-green-100 rounded-lg flex items-center justify-center text-green-600">
                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.046.246.246 0 0 0 .242-.246c0-.06-.024-.12-.04-.178l-.325-1.233a.492.492 0 0 1 .178-.553C23.028 18.333 24 16.592 24 14.628c0-3.299-3.063-5.77-7.062-5.77zm-2.18 3.452c.535 0 .969.44.969.983a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.983.97-.983zm4.844 0c.535 0 .969.44.969.983a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.983.97-.983z"/>
                            </svg>
                          </div>
                          <div className="text-left">
                            <p className="text-sm font-medium text-gray-700">我是管理员</p>
                            <p className="text-xs text-gray-400">扫码后输入管理员密码绑定</p>
                          </div>
                        </div>
                        <ChevronRight className="text-gray-300" size={18} />
                      </button>

                      </div>
                  )}

                  {wechatMode === 'admin' && (
                    <>
                      <div className="flex items-center justify-between">
                        <button
                          onClick={() => {
                            if (adminMemberId && !adminBotLoggedIn) {
                              axios.post(getFullApiUrl('/api/wechat/stop-bot'), { memberId: adminMemberId }).catch(() => {});
                            }
                            setWechatMode(null); setAdminBotInfo(null); setAdminBotLoggedIn(false); setAdminStep(null); setAdminMemberId(null); localStorage.removeItem('adminBotMemberId');
                          }}
                          className="text-sm text-blue-600 hover:text-blue-800"
                        >
                          ← 返回
                        </button>
                        <p className="text-sm font-medium text-gray-600">管理员</p>
                      </div>

                      {!adminBotInfo && !adminStep && !adminMemberId && (
                        <button
                          onClick={() => setAdminStep('password')}
                          className="w-full flex items-center justify-center gap-2 p-3 border border-green-200 rounded-xl hover:bg-green-50 transition-all"
                        >
                          <svg className="w-5 h-5 text-green-600" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.046.246.246 0 0 0 .242-.246c0-.06-.024-.12-.04-.178l-.325-1.233a.492.492 0 0 1 .178-.553C23.028 18.333 24 16.592 24 14.628c0-3.299-3.063-5.77-7.062-5.77zm-2.18 3.452c.535 0 .969.44.969.983a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.983.97-.983zm4.844 0c.535 0 .969.44.969.983a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.983.97-.983z"/>
                          </svg>
                          <span className="text-sm font-medium text-gray-700">绑定微信 Bot</span>
                        </button>
                      )}

                      {adminStep === 'password' && !adminBotInfo && (
                        <AdminPasswordInput
                          onBack={() => setAdminStep(null)}
                          onSuccess={(result) => {
                            setAdminBotInfo(result);
                            if (result.memberId) {
                              localStorage.setItem('adminBotMemberId', result.memberId);
                              localStorage.setItem('adminDeviceToken', result.memberId);
                              setAdminMemberId(result.memberId);
                            }
                            setAdminStep(null);
                          }}
                        />
                      )}

                      {!adminBotInfo && adminMemberId && (
                        <div className="text-center py-8">
                          <svg className="animate-spin w-8 h-8 mx-auto text-gray-300 mb-2" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                          <p className="text-xs text-gray-400">正在连接你的Bot...</p>
                        </div>
                      )}

                      {(adminBotInfo || (adminBotInfo && adminBotInfo.loggedIn) || adminBotLoggedIn) && (
                        <>
                          <div className="bg-white rounded-xl p-3 border border-gray-200 inline-block mx-auto w-full">
                            {adminBotInfo?.qrcodeUrl && !adminBotLoggedIn && !adminBotInfo?.loggedIn ? (
                              <div className="flex flex-col items-center">
                                <img
                                  key={adminBotInfo.qrcodeUrl}
                                  src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(adminBotInfo.qrcodeUrl)}`}
                                  alt="微信连接二维码"
                                  className="w-40 h-40"
                                />
                              </div>
                            ) : null}
                            {adminBotLoggedIn || adminBotInfo?.loggedIn ? (
                              <div className="text-center py-4">
                                <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-2">
                                  <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                  </svg>
                                </div>
                                <p className="text-sm font-medium text-green-700">Bot 已上线</p>
                                <p className="text-xs text-gray-500 mt-1">你的微信 Bot 已在线，可直接对话管理</p>
                              </div>
                            ) : null}
                            {!adminBotInfo?.qrcodeUrl && !adminBotLoggedIn && (
                              <div className="text-center py-8">
                                <svg className="animate-spin w-8 h-8 mx-auto text-gray-300 mb-2" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                </svg>
                                <p className="text-xs text-gray-400">等待二维码生成...</p>
                              </div>
                            )}
                          </div>

                          {!adminBotLoggedIn && !adminBotInfo?.loggedIn && (
                            <div className="p-3 bg-green-50 border border-green-100 rounded-xl">
                              <div className="flex items-center gap-2 mb-1">
                                <svg className="w-4 h-4 text-green-600" viewBox="0 0 24 24" fill="currentColor">
                                  <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.046.246.246 0 0 0 .242-.246c0-.06-.024-.12-.04-.178l-.325-1.233a.492.492 0 0 1 .178-.553C23.028 18.333 24 16.592 24 14.628c0-3.299-3.063-5.77-7.062-5.77zm-2.18 3.452c.535 0 .969.44.969.983a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.983.97-.983zm4.844 0c.535 0 .969.44.969.983a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.983.97-.983z"/>
                                </svg>
                                <p className="text-sm font-semibold text-green-700">绑定说明</p>
                              </div>
                              <ol className="text-xs text-gray-600 ml-4 list-decimal space-y-0.5">
                                <li>用微信扫描上方二维码</li>
                                <li>你的专属 Bot 将自动上线</li>
                                <li>在微信中与 Bot 对话即可管理系统</li>
                              </ol>
                            </div>
                          )}
                        </>
                      )}
                    </>
                  )}

                  {wechatMode !== null && (
                    <button
                      onClick={() => {
                        if (wechatMode === 'admin' && adminMemberId && !adminBotLoggedIn) {
                          axios.post(getFullApiUrl('/api/wechat/stop-bot'), { memberId: adminMemberId }).catch(() => {});
                        }
                        setWechatMode(null); setShowWechatConnect(false);
                      }}
                      className="w-full px-4 py-2 text-sm text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg"
                    >
                      关闭
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          
          {loginStep === 'class' ? (
            <>
              <div className="flex justify-between items-center mb-8">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowGuideModal(true)}
                    className="text-sm font-bold text-gray-600 hover:text-gray-700 bg-gray-50 px-3 py-1.5 rounded-lg border border-gray-100 flex items-center gap-1 transition-all shadow-sm"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    操作指南
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      loginModalOpen.current = true;
                      setShowAdminPasswordModal(true);
                    }}
                    className="text-sm font-bold text-blue-600 hover:text-blue-700 bg-blue-50 px-3 py-1.5 rounded-lg border border-blue-100 flex items-center gap-1 transition-all shadow-sm"
                  >
                    <BarChart3 size={16} />
                    查看所有人评分
                  </button>
                  <button
                    onClick={initPlayMode}
                    className="text-sm font-bold text-green-600 hover:text-green-700 bg-green-50 px-3 py-1.5 rounded-lg border border-green-100 flex items-center gap-1 transition-all shadow-sm"
                  >
                    <Play size={16} />
                    播放模式
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                {classes.map(className => (
                  <button
                    key={className}
                    onClick={() => {
                      setSelectedClass(className);
                      setLoginStep('member');
                    }}
                    className="p-5 border border-gray-200 rounded-xl hover:bg-blue-50 hover:border-blue-300 transition-all text-center font-medium text-gray-700 shadow-sm hover:shadow-md"
                  >
                    {maskClassName(className)}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-3 mb-8">
                <button 
                  onClick={() => setLoginStep('class')}
                  className="flex items-center gap-1 text-blue-600 text-sm hover:text-blue-700 font-medium transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                  返回选择班级
                </button>
                <span className="text-gray-400">|</span>
                <span className="text-gray-700 font-bold text-lg">{maskClassName(selectedClass)}</span>
              </div>
              <h3 className="text-xl font-bold text-center text-gray-800 mb-6">请选择您的姓名</h3>
              <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                {filteredMembers.map(member => (
                  <button
                    key={member.id}
                    onClick={() => {
                      loginModalOpen.current = true;
                      if (member.password) {
                        setPendingMember(member);
                        setPasswordMode('verify');
                        setShowPasswordModal(true);
                      } else {
                        setPendingMember(member);
                        setPasswordMode('set');
                        setShowPasswordModal(true);
                      }
                    }}
                    className="w-full flex items-center justify-between p-4 border border-gray-200 rounded-xl hover:bg-blue-50 hover:border-blue-300 transition-all group shadow-sm hover:shadow-md"
                  >
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-blue-100 rounded-lg text-blue-600">
                        <User size={20} />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-700">{maskName(member.name)}</span>
                        <div className="flex items-center gap-1">
                          {(() => {
                            const status = memberStatusMap[member.id];
                            if (!status) return null;
                            return (
                              <>
                                {status.hasFitnessFail && (
                                  <AlertTriangle size={16} className="text-red-500" />
                                )}
                                {status.hasFitnessPass && !status.hasFitnessFail && (
                                  <CheckCircle2 size={16} className="text-green-500" />
                                )}
                                {status.hasInjury && (
                                  <HeartPulse size={16} className="text-orange-500" />
                                )}
                                {status.hasScoreDecline && (
                                  <TrendingDown size={16} className="text-purple-500" />
                                )}
                                {status.hasScoreProgress && (
                                  <TrendingUp size={16} className="text-blue-500" />
                                )}
                              </>
                            );
                          })()}
                        </div>
                      </div>
                    </div>
                    <ChevronRight className="text-gray-300 group-hover:text-blue-500 transition-colors" size={20} />
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Password Modal */}
          {showPasswordModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40">
              <div className="bg-white rounded-2xl p-8 max-w-md w-full">
                <h3 className="text-xl font-bold text-gray-900 mb-4">
                  {passwordMode === 'verify' ? '请输入密码' : '设置密码'}
                </h3>
                <p className="text-gray-600 mb-4">
                  {passwordMode === 'verify' 
                    ? `请为 ${pendingMember?.name} 输入密码登录` 
                    : `请为 ${pendingMember?.name} 设置密码（至少4位）`}
                </p>
                <input
                  type="password"
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder="请输入密码"
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      if (passwordMode === 'verify') {
                        handlePasswordVerify();
                      } else {
                        handlePasswordSet();
                      }
                    }
                  }}
                />
                <div className="flex gap-3">
                  <button
                    onClick={() => {
                      loginModalOpen.current = false;
                      setShowPasswordModal(false);
                      setPasswordInput('');
                      setPendingMember(null);
                    }}
                    className="flex-1 px-4 py-3 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                  >
                    取消
                  </button>
                  <button
                    onClick={() => {
                      if (passwordMode === 'verify') {
                        handlePasswordVerify();
                      } else {
                        handlePasswordSet();
                      }
                    }}
                    className="flex-1 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    {passwordMode === 'verify' ? '登录' : '设置密码'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Admin Password Modal */}
          {showAdminPasswordModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40">
              <div className="bg-white rounded-2xl p-8 max-w-md w-full">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-xl font-bold text-gray-900">查看所有人评分</h3>
                  <button
                    onClick={() => {
                      loginModalOpen.current = false;
                      setShowAdminPasswordModal(false);
                      setAdminPasswordInput('');
                    }}
                    className="text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    <X size={24} />
                  </button>
                </div>
                <p className="text-gray-600 mb-4">输入管理密码或点击跳过以普通模式进入</p>
                <input
                  type="password"
                  value={adminPasswordInput}
                  onChange={(e) => setAdminPasswordInput(e.target.value)}
                  placeholder="请输入管理密码（可选）"
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleAdminPasswordVerify();
                    }
                  }}
                />
                <div className="flex gap-3">
                  <button
                    onClick={() => {
                      loginModalOpen.current = false;
                      setShowAdminPasswordModal(false);
                      setAdminPasswordInput('');
                      setIsPublicView(true);
                      setIsAdmin(false);
                      setCurrentUser({ name: '游客', class: '公共', id: 'guest' });
                      setPositiveNominationClass('公共');
                      setNegativeNominationClass('公共');
                      setSelectedClass(classes[0]);
                      setView('dashboard');
                    }}
                    className="flex-1 px-4 py-3 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                  >
                    跳过
                  </button>
                  <button
                    onClick={handleAdminPasswordVerify}
                    className="flex-1 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    验证
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Admin Nickname Setup Modal */}
          {showAdminNicknameModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40">
              <div className="bg-white rounded-2xl p-8 max-w-md w-full">
                <h3 className="text-xl font-bold text-gray-900 mb-2">设置你的管理员昵称</h3>
                <p className="text-sm text-gray-500 mb-4">
                  首次登录需设置昵称，方便跨设备识别和管理员画像。
                </p>
                <input
                  type="text"
                  value={adminNicknameInput}
                  onChange={(e) => setAdminNicknameInput(e.target.value)}
                  placeholder="例如：刘队长"
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  onKeyDown={async (e) => {
                    if (e.key === 'Enter') {
                      const deviceId = getAdminDeviceId();
                      const pwd = adminPasswordStashRef.current || adminPasswordInput;
                      if (!pwd) {
                        showNotification('密码已失效，请重新登录', 'error');
                        setShowAdminNicknameModal(false);
                        return;
                      }
                      try {
                        const res = await axios.post(getFullApiUrl('/api/admin/set-nickname'), {
                          adminDeviceId: deviceId, nickname: adminNicknameInput, password: pwd
                        });
                        if (res.data.success) {
                          adminPasswordStashRef.current = '';
                          localStorage.setItem('adminDeviceToken', res.data.adminId);
                          localStorage.setItem('adminBotMemberId', res.data.adminId);
                          setShowAdminNicknameModal(false);
                          setIsPublicView(true); setIsAdmin(true); setIsSuperAdmin(false);
                          setCurrentUser({ name: res.data.nickname, class: '全校', id: res.data.adminId, deviceId: res.data.adminId });
                          setPositiveNominationClass(classes[0]); setNegativeNominationClass(classes[0]);
                          setSelectedClass(classes[0]); setView('dashboard');
                          setTargetMember(members.find(m => m.class === classes[0]));
                          if (members.find(m => m.class === classes[0])) fetchStats(members.find(m => m.class === classes[0]).id);
                          fetchCurrentVersion();
                          showNotification(`${res.data.nickname} 登录成功！`);
                        }
                      } catch (err) { showNotification('设置失败，请重试', 'error'); }
                    }
                  }}
                />
                <div className="flex gap-3">
                  <button
                    onClick={() => {
                      setShowAdminNicknameModal(false);
                      const deviceId = getAdminDeviceId();
                      setIsPublicView(true); setIsAdmin(true); setIsSuperAdmin(false);
                      setCurrentUser({ name: getAdminShortId(), class: '全校', id: deviceId, deviceId });
                      setPositiveNominationClass(classes[0]); setNegativeNominationClass(classes[0]);
                      setSelectedClass(classes[0]); setView('dashboard');
                      setTargetMember(members.find(m => m.class === classes[0]));
                      if (members.find(m => m.class === classes[0])) fetchStats(members.find(m => m.class === classes[0]).id);
                      fetchCurrentVersion();
                      showNotification(`${getAdminShortId()} 登录成功！（可稍后在绑定微信后设置昵称）`);
                    }}
                    className="flex-1 px-4 py-3 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                  >
                    跳过
                  </button>
                  <button
                    onClick={async () => {
                      const deviceId = getAdminDeviceId();
                      const pwd = adminPasswordStashRef.current || adminPasswordInput;
                      if (!pwd) {
                        showNotification('密码已失效，请重新登录', 'error');
                        setShowAdminNicknameModal(false);
                        return;
                      }
                      try {
                        const res = await axios.post(getFullApiUrl('/api/admin/set-nickname'), {
                          adminDeviceId: deviceId, nickname: adminNicknameInput, password: pwd
                        });
                        if (res.data.success) {
                          adminPasswordStashRef.current = '';
                          localStorage.setItem('adminDeviceToken', res.data.adminId);
                          localStorage.setItem('adminBotMemberId', res.data.adminId);
                          setShowAdminNicknameModal(false);
                          setIsPublicView(true); setIsAdmin(true); setIsSuperAdmin(false);
                          setCurrentUser({ name: res.data.nickname, class: '全校', id: res.data.adminId, deviceId: res.data.adminId });
                          setPositiveNominationClass(classes[0]); setNegativeNominationClass(classes[0]);
                          setSelectedClass(classes[0]); setView('dashboard');
                          setTargetMember(members.find(m => m.class === classes[0]));
                          if (members.find(m => m.class === classes[0])) fetchStats(members.find(m => m.class === classes[0]).id);
                          fetchCurrentVersion();
                          showNotification(`${res.data.nickname} 登录成功！`);
                        }
                      } catch (err) { showNotification('设置失败，请重试', 'error'); }
                    }}
                    className="flex-1 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    确认
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Set Password Modal */}
          {showSetPasswordModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40">
              <div className="bg-white rounded-2xl p-8 max-w-md w-full">
                <h3 className="text-xl font-bold text-gray-900 mb-4">设置管理密码</h3>
                <label className="block text-sm font-medium text-gray-700 mb-1">新密码</label>
                <input
                  type="password"
                  value={newPasswordInput}
                  onChange={(e) => setNewPasswordInput(e.target.value)}
                  placeholder="请输入新密码（至少4位）"
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <label className="block text-sm font-medium text-gray-700 mb-1">确认密码</label>
                <input
                  type="password"
                  value={confirmPasswordInput}
                  onChange={(e) => setConfirmPasswordInput(e.target.value)}
                  placeholder="请再次输入新密码"
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleSetAdminPassword();
                    }
                  }}
                />
                <div className="flex gap-3">
                  <button
                    onClick={() => {
                      setShowSetPasswordModal(false);
                      setOldPasswordInput('');
                      setNewPasswordInput('');
                      setConfirmPasswordInput('');
                    }}
                    className="flex-1 px-4 py-3 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleSetAdminPassword}
                    className="flex-1 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    确定
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Guide Modal */}
          {showGuideModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40 p-4">
              <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
                <div className="sticky top-0 bg-white z-10 flex justify-between items-center p-8 pb-6 border-b border-gray-100">
                  <h3 className="text-2xl font-bold text-gray-900">操作指南</h3>
                  <button
                    onClick={() => setShowGuideModal(false)}
                    className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-full"
                  >
                    <X size={24} />
                  </button>
                </div>
                <div className="p-8 pt-6">

                <div className="space-y-6">
                  {/* 系统介绍 */}
                  <section>
                    <h4 className="text-lg font-bold text-blue-600 mb-3 flex items-center gap-2">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      六维评分标准
                    </h4>
                    <div className="bg-gray-50 p-4 rounded-lg text-sm text-gray-700">
                      <p className="mb-3">班级评分系统包含六大评价维度，每个维度下设若干二级评分项目，采用10分制评分。</p>
                      <div className="space-y-4">
                        {dimensions.map(dim => (
                          <div key={dim.key} className="border border-gray-200 rounded-lg overflow-hidden bg-white">
                            <div className="bg-blue-50 px-3 py-2 flex justify-between items-center">
                              <span className="font-bold text-blue-800">{dim.label}</span>
                              <span className="text-xs text-blue-600">满分{(() => {
                                const total = dim.subItems.reduce((sum, item) => sum + item.maxScore, 0);
                                return total;
                              })()}分</span>
                            </div>
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="bg-gray-100">
                                  <th className="px-2 py-1 text-left font-medium text-gray-600 w-1/5">二级项目</th>
                                  <th className="px-2 py-1 text-center font-medium text-gray-600 w-16">分值</th>
                                  <th className="px-2 py-1 text-left font-medium text-gray-600">评分标准</th>
                                </tr>
                              </thead>
                              <tbody>
                                {dim.subItems.map((item, idx) => (
                                  <tr key={item.key} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                                    <td className="px-2 py-1.5 font-medium text-gray-700">{item.label}</td>
                                    <td className="px-2 py-1.5 text-center text-blue-600 font-bold">{item.maxScore}</td>
                                    <td className="px-2 py-1.5 text-gray-600">{item.criteria}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ))}
                      </div>
                    </div>
                  </section>

                  {/* 操作方法 */}
                  <section>
                    <h4 className="text-lg font-bold text-green-600 mb-3 flex items-center gap-2">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      操作方法
                    </h4>
                    <div className="bg-gray-50 p-4 rounded-lg text-sm text-gray-700 space-y-3">
                      <div>
                        <p className="font-medium text-gray-800">1. 个人登录：</p>
                        <ul className="list-disc list-inside ml-2 space-y-1">
                          <li>选择班级 → 选择姓名 → 输入密码（首次登录时自动设置密码）</li>
                          <li>登录后可查看个人评分数据、完善个人信息</li>
                        </ul>
                      </div>
                      <div>
                        <p className="font-medium text-gray-800">2. 查看所有人评分：</p>
                        <ul className="list-disc list-inside ml-2 space-y-1">
                          <li>点击"查看所有人评分"按钮</li>
                          <li>输入管理密码或点击"跳过"以普通游客模式进入</li>
                          <li>可查看所有班级成员的评分数据</li>
                        </ul>
                      </div>
                      <div>
                        <p className="font-medium text-gray-800">3. 播放模式：</p>
                        <ul className="list-disc list-inside ml-2 space-y-1">
                          <li>点击"播放模式"按钮自动轮播各班级评分</li>
                        </ul>
                      </div>
                    </div>
                  </section>

                  {/* 图标说明 */}
                  <section>
                    <h4 className="text-lg font-bold text-purple-600 mb-3 flex items-center gap-2">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                      图标说明
                    </h4>
                    <div className="bg-gray-50 p-4 rounded-lg text-sm text-gray-700">
                      <div className="grid grid-cols-1 gap-3">
                        <div className="flex items-center gap-3 p-2 bg-white rounded-lg border">
                          <CheckCircle2 size={20} className="text-green-500" />
                          <div>
                            <p className="font-medium text-gray-800">体能及格</p>
                            <p className="text-xs text-gray-500">表示该成员的体能成绩全部及格</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 p-2 bg-white rounded-lg border">
                          <AlertTriangle size={20} className="text-red-500" />
                          <div>
                            <p className="font-medium text-gray-800">体能不及格</p>
                            <p className="text-xs text-gray-500">表示该成员的体能成绩中有不及格项</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 p-2 bg-white rounded-lg border">
                          <HeartPulse size={20} className="text-orange-500" />
                          <div>
                            <p className="font-medium text-gray-800">伤病号</p>
                            <p className="text-xs text-gray-500">表示该成员有体能项目未参考</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 p-2 bg-white rounded-lg border">
                          <TrendingUp size={20} className="text-blue-500" />
                          <div>
                            <p className="font-medium text-gray-800">学习成绩进步</p>
                            <p className="text-xs text-gray-500">表示该成员的学习成绩排名较上学期提升</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 p-2 bg-white rounded-lg border">
                          <TrendingDown size={20} className="text-purple-500" />
                          <div>
                            <p className="font-medium text-gray-800">学习成绩退步</p>
                            <p className="text-xs text-gray-500">表示该成员的学习成绩排名较上学期下降</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </section>

                  {/* PDF预览 */}
                  <section>
                    <h4 className="text-lg font-bold text-orange-600 mb-3 flex items-center gap-2">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      相关文档
                    </h4>
                    <div className="bg-gray-50 p-4 rounded-lg">
                      <button
                        onClick={async () => {
                          // 在原生移动环境中直接下载并打开PDF，不显示预览
                          if (window.Capacitor?.platform !== 'web') {
                            await downloadFile(getFullApiUrl("/六维雷达图评分维度及评分细则.pdf"), "六维雷达图评分维度及评分细则.pdf", true);
                          } else {
                            setShowPdfPreview(true);
                          }
                        }}
                        className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        查看六维雷达图评分维度及评分细则
                      </button>
                    </div>
                  </section>
                </div>
                </div>
              </div>
            </div>
          )}

          {/* PDF Preview Modal */}
          {showPdfPreview && (
            <div className="fixed inset-0 z-50 bg-black bg-opacity-80 flex items-center justify-center p-4">
              <div className="bg-white rounded-2xl w-full max-w-[80vw] h-[80vh] overflow-hidden flex flex-col shadow-2xl">
                <div className="flex justify-between items-center p-4 bg-gray-900 text-white">
                  <h3 className="text-lg font-bold">六维雷达图评分维度及评分细则</h3>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => downloadFile(getFullApiUrl("/六维雷达图评分维度及评分细则.pdf"), "六维雷达图评分维度及评分细则.pdf")}
                      className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                    >
                      <Download size={18} />
                      下载
                    </button>
                    <button
                      onClick={() => setShowPdfPreview(false)}
                      className="text-gray-400 hover:text-white transition-colors p-2"
                    >
                      <X size={28} />
                    </button>
                  </div>
                </div>
                <div className="flex-1 overflow-hidden flex flex-col">
                  {/* 评分细则PDF内容区域 */}
                  <div className="flex-1 bg-gray-900 flex items-center justify-center p-4">
                    <embed
                      src={getFullApiUrl("/六维雷达图评分维度及评分细则.pdf")}
                      type="application/pdf"
                      className="w-full h-full"
                      onLoad={(e) => {
                        console.log('Guide PDF loaded successfully');
                        setGuidePdfLoading(false);
                        setGuidePdfNumPages(1);
                      }}
                      onError={(e) => {
                        console.error('Guide PDF load error:', e);
                        setGuidePdfError('评分细则加载失败');
                      }}
                    />
                    {guidePdfLoading && (
                      <div className="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-80">
                        <div className="text-center">
                          <div className="w-16 h-16 border-4 border-gray-600 border-t-blue-500 rounded-full animate-spin mx-auto mb-4"></div>
                          <p className="text-gray-400 text-lg">评分细则加载中...</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (view === 'play') {
    const frame = playFrames.length ? (playFrames[playFrameIdx] || playFrames[0]) : null;
    const totalFrames = playFrames.length;
    const isUrl = !!(frame && frame.kind === 'url');
    const curDur = (frame && frame.duration) || 8;
    const weekLabel = `第${Math.max(1, config.currentWeek - 1)}周`;
    const title = !frame ? '' : frame.kind === 'radar'
      ? maskClassName(frame.className)
      : (frame.label || (frame.kind === 'image' ? '图片' : '网页'));

    let mainBody = null;
    if (!frame) {
      mainBody = (
        <div className="flex-1 flex items-center justify-center text-gray-500 text-2xl relative z-10">
          暂无上周评分数据
        </div>
      );
    } else if (frame.kind === 'radar') {
      const currentClass = playModeClasses[frame.classIdx];
      if (!currentClass) {
        mainBody = (
          <div className="flex-1 flex items-center justify-center text-gray-500 text-2xl relative z-10">
            暂无上周评分数据
          </div>
        );
      } else {
        const membersPerPage = 6;
        const startIdx = frame.page * membersPerPage;
        const endIdx = Math.min(startIdx + membersPerPage, currentClass.members.length);
        const displayMembers = currentClass.members.slice(startIdx, endIdx);
        mainBody = (
          <div className="flex-1 flex items-center justify-center px-4 pb-2 relative z-10 min-h-0">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 w-full max-w-[1200px] justify-items-center">
              {displayMembers.map((item, idx) => (
                <div key={idx} className="bg-white rounded-xl p-4 text-center shadow-md transition-all duration-500 border border-gray-100 hover:shadow-lg hover:-translate-y-1" style={{ width: '320px' }}>
                  <h3 className="text-lg font-bold text-slate-800 mb-2">{maskName(item.member.name)}</h3>
                  {item.stats ? (
                    <>
                      <ReactECharts 
                        option={(() => {
                          const prevWeekData = item.allStats && item.currentWeek 
                            ? item.allStats.find(s => s.week === item.currentWeek - 1) 
                            : null;
                          const baseOption = getRadarOption(item.stats, prevWeekData);
                          return {
                            ...baseOption,
                            title: { show: false },
                            tooltip: { show: false },
                            legend: { show: false },
                            radar: {
                              ...baseOption.radar,
                              radius: '70%',
                              name: {
                                textStyle: {
                                  color: '#374151',
                                  fontSize: 10
                                }
                              },
                              indicator: dimensions.map(d => ({
                                name: d.label,
                                max: 10
                              })),
                              splitArea: { show: true, areaStyle: { color: ['rgba(255,255,255,0.8)', 'rgba(243,244,246,0.8)'] } },
                              axisLine: { lineStyle: { color: '#d1d5db' } },
                              splitLine: { lineStyle: { color: '#e5e7eb' } }
                            },
                            series: baseOption.series.map((s, idx) => {
                              if (idx === 0) {
                                return {
                                  ...s,
                                  areaStyle: { color: 'rgba(59, 130, 246, 0.3)' },
                                  lineStyle: { width: 3, color: '#3b82f6' },
                                  itemStyle: { color: '#3b82f6', borderWidth: 0 },
                                  symbol: 'none'
                                };
                              }
                              return s;
                            })
                          };
                        })()}
                        style={{ height: '180px' }} 
                      />
                      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5">
                        {dimensions.map(d => (
                          <div key={d.key} className="flex justify-between items-center text-[10px]">
                            <span className="text-gray-500 truncate max-w-[70px]">{d.label}</span>
                            <span className="font-bold text-blue-600 ml-1">{item.stats.averages[d.key].toFixed(1)}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="h-[180px] flex items-center justify-center text-gray-400 text-sm">
                      暂无数据
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      }
    } else if (frame.kind === 'image') {
      mainBody = (
        <div className="flex-1 flex items-center justify-center px-6 pb-2 relative z-10 min-h-0">
          <img src={frame.url} alt={title} className="max-h-full max-w-full object-contain rounded-xl shadow-md" />
        </div>
      );
    }

    return (
      <div className="fixed inset-0 bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50 flex flex-col overflow-hidden">
        <ParticleBackground color="99, 102, 241" particleCount={30} speed={0.15} linkDistance={80} />
        <div className="flex items-center justify-between px-6 pt-3 pb-2 relative z-20">
          <div className="flex-1"></div>
          <div className="text-center flex-1 min-w-0 px-2">
            <h1 className="text-2xl font-bold text-slate-800 truncate">{title}</h1>
            <p className="text-xs text-gray-500">
              {weekLabel}{title ? ' · ' : ''}{totalFrames > 0 ? `播放 ${playFrameIdx + 1}/${totalFrames} · ${curDur}秒切换` : ''}
            </p>
          </div>
          <div className="flex-1 flex justify-end">
            <button
              onClick={() => setView('login')}
              className="p-2 bg-white text-slate-700 rounded-full hover:bg-gray-100 transition-colors shadow-sm border border-gray-200"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* 主体：雷达 / 图片 / 空态（网页帧时留空，交给下方保活层） */}
        {!isUrl && mainBody}

        {/* 网页保活层：常驻挂载不销毁（切走隐藏 → 保滚动记忆/秒回），仅当前为网页时可见可交互 */}
        <div
          className="absolute inset-x-1 bottom-1 top-[68px] z-10 rounded-xl overflow-hidden shadow-md"
          style={{ display: isUrl ? 'block' : 'none' }}
          aria-hidden={!isUrl}
        >
          {isUrl && (
            <div className="relative w-full h-full bg-white">
              {urlKept.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-lg">
                  正在打开网页…
                </div>
              )}
              {urlKept.map(u => (
                <iframe
                  key={u.key}
                  src={u.url}
                  title={u.label || u.key}
                  className="absolute inset-0 w-full h-full border-0"
                  style={{ display: u.key === frame.key ? 'block' : 'none' }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50 relative">
      <ParticleBackground color="99, 102, 241" particleCount={30} speed={0.15} linkDistance={80} />
      {/* Notification */}
      {notification.show && (
        <div className={`fixed top-4 left-1/2 transform -translate-x-1/2 z-[9999] px-6 py-3 rounded-xl shadow-lg transition-all duration-300 ${
          notification.type === 'success' ? 'bg-green-500 text-white' : 'bg-red-500 text-white'
        }`}>
          {notification.message}
        </div>
      )}

      {/* 后台保活权限引导弹窗（原生环境 + 未加入电池优化白名单时显示） */}
      {showPermissionGuide && isCapacitorNative && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 10000, display: 'flex',
          alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)'
        }}>
          <div style={{
            background: 'white', borderRadius: 12, padding: 20, width: 'min(92vw, 380px)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.3)', fontSize: 14, color: '#1f2937'
          }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12, color: '#dc2626' }}>
              开启推送保活权限
            </div>
            <div style={{ lineHeight: 1.6, marginBottom: 16, color: '#4b5563' }}>
              为确保 APP 被关闭后仍能收到通知，请开启以下权限：
              <ol style={{ margin: '8px 0 0 18px', padding: 0 }}>
                <li style={{ marginBottom: 4 }}><b>自启动</b>：允许应用自启动</li>
                <li style={{ marginBottom: 4 }}><b>电池优化白名单</b>：不受省电模式限制</li>
                <li style={{ marginBottom: 4 }}><b>后台活动</b>：允许后台运行</li>
              </ol>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button
                onClick={async () => {
                  try {
                    const { JPush } = window.Capacitor?.Plugins || {};
                    if (JPush?.requestIgnoreBatteryOptimization) {
                      await JPush.requestIgnoreBatteryOptimization();
                    }
                  } catch (e) { console.warn(e); }
                }}
                style={btnStyle}
              >
                1. 加入电池优化白名单
              </button>
              <button
                onClick={async () => {
                  try {
                    const { JPush } = window.Capacitor?.Plugins || {};
                    if (JPush?.openAutoStartSettings) {
                      await JPush.openAutoStartSettings();
                    }
                  } catch (e) { console.warn(e); }
                }}
                style={btnStyle}
              >
                2. 跳转自启动管理（{permCheckResult.brand || '本机'}）
              </button>
              <button
                onClick={async () => {
                  try {
                    const { JPush } = window.Capacitor?.Plugins || {};
                    if (JPush?.openAppSettings) {
                      await JPush.openAppSettings();
                    }
                  } catch (e) { console.warn(e); }
                }}
                style={btnStyle}
              >
                3. 应用详情设置（权限/后台）
              </button>
              <button
                onClick={async () => {
                  // 重新检查电池优化状态
                  try {
                    const { JPush } = window.Capacitor?.Plugins || {};
                    if (JPush?.checkBatteryOptimization) {
                      const bat = await JPush.checkBatteryOptimization();
                      setPermCheckResult({ batteryIgnored: bat.isIgnored, brand: bat.brand || '' });
                      if (bat.isIgnored) {
                        setShowPermissionGuide(false);
                        localStorage.setItem('push_perm_confirmed', '1');
                        alert('电池优化白名单已开启，推送保活已生效');
                      } else {
                        // 电池优化白名单未开启，但厂商自启动等权限无法检测，提示用户
                        const confirmed = confirm('电池优化白名单状态：未开启\n\n注：厂商的"自启动/关联启动/后台活动"权限无法自动检测。\n如你已在系统中开启所有相关权限，点击"确定"关闭此弹窗，"取消"则继续显示。');
                        if (confirmed) {
                          setShowPermissionGuide(false);
                          localStorage.setItem('push_perm_confirmed', '1');
                        }
                      }
                    }
                  } catch (e) { console.warn(e); }
                }}
                style={{ ...btnStyle, background: '#10b981' }}
              >
                重新检测
              </button>
              <button
                onClick={() => {
                  setShowPermissionGuide(false);
                  localStorage.setItem('push_perm_confirmed', '1');
                }}
                style={{ ...btnStyle, background: '#9ca3af' }}
              >
                我已开启，关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* JPush 推送诊断面板（仅原生环境显示，或日志非空时） */}
      {(isCapacitorNative || pushDebugLogs.length > 0) && (
        <>
          <button
            onClick={() => setShowPushDebug(s => !s)}
            style={{
              position: 'fixed', right: 12, bottom: 12, zIndex: 9999,
              padding: '8px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
              background: pushDebugLogs.some(l => l.level === 'error') ? '#ef4444'
                        : pushDebugLogs.some(l => l.level === 'warn') ? '#f59e0b' : '#6366f1',
              color: 'white', fontSize: 12, fontWeight: 600,
              boxShadow: '0 2px 8px rgba(0,0,0,0.2)'
            }}
          >
            {showPushDebug ? '关闭' : '推送'} {pushDebugLogs.length > 0 && `(${pushDebugLogs.length})`}
          </button>
          {showPushDebug && (
            <div style={{
              position: 'fixed', right: 12, bottom: 50, zIndex: 9999,
              width: 'min(92vw, 460px)', maxHeight: '60vh', overflowY: 'auto',
              background: '#1e1e1e', color: '#d4d4d4', borderRadius: 8,
              padding: 12, fontSize: 11, fontFamily: 'Consolas, Monaco, monospace',
              boxShadow: '0 8px 24px rgba(0,0,0,0.4)', lineHeight: 1.5
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, borderBottom: '1px solid #444', paddingBottom: 6 }}>
                <span style={{ color: '#fff', fontWeight: 600 }}>推送诊断日志</span>
                <div>
                  <button onClick={async () => {
                    try {
                      const { JPush } = window.Capacitor?.Plugins || {};
                      if (!JPush?.getForegroundServiceLog) {
                        pushLog('getForegroundServiceLog 方法不可用', 'error');
                        return;
                      }
                      const info = await JPush.getForegroundServiceLog();
                      setFgServiceInfo(info);
                      pushLog(`读取前台服务日志: apiUrl=${info.apiUrl}, memberId=${info.memberId}, lastNotifId=${info.lastNotifId}`);
                    } catch (e) { pushLog(`读取前台服务日志失败: ${e.message}`, 'error'); }
                  }}
                    style={{ background: '#3a3a3a', color: '#34d399', border: '1px solid #555', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', marginRight: 4 }}>
                    前台服务
                  </button>
                  <button onClick={() => setShowPermissionGuide(true)}
                    style={{ background: '#3a3a3a', color: '#fbbf24', border: '1px solid #555', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', marginRight: 4 }}>
                    保活权限
                  </button>
                  <button onClick={() => { const txt = pushDebugLogs.map(l => `[${l.time}] ${l.level.toUpperCase()} ${l.msg}`).join('\n'); navigator.clipboard?.writeText(txt); }}
                    style={{ background: '#3a3a3a', color: '#d4d4d4', border: '1px solid #555', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', marginRight: 4 }}>
                    复制
                  </button>
                  <button onClick={() => setPushDebugLogs([])}
                    style={{ background: '#3a3a3a', color: '#d4d4d4', border: '1px solid #555', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}>
                    清空
                  </button>
                </div>
              </div>
              {pushDebugLogs.length === 0 && !fgServiceInfo ? (
                <div style={{ color: '#888', fontStyle: 'italic' }}>暂无日志，登录后将开始记录</div>
              ) : (
                <>
                  {pushDebugLogs.map((l, i) => (
                    <div key={'js'+i} style={{
                      color: l.level === 'error' ? '#f87171' : l.level === 'warn' ? '#fbbf24' : '#9ca3ff',
                      marginBottom: 2, wordBreak: 'break-all'
                    }}>
                      <span style={{ color: '#666' }}>[{l.time}]</span> {l.msg}
                    </div>
                  ))}
                  {fgServiceInfo && (
                    <div style={{ borderTop: '1px solid #444', paddingTop: 6, marginTop: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ color: '#34d399', fontWeight: 600 }}>前台服务日志（独立进程）</span>
                        <button onClick={() => setFgServiceInfo(null)}
                          style={{ background: '#3a3a3a', color: '#888', border: '1px solid #555', borderRadius: 4, padding: '1px 6px', cursor: 'pointer', fontSize: 10 }}>
                          关闭
                        </button>
                      </div>
                      <div style={{ color: '#fbbf24', fontSize: 10, marginBottom: 4 }}>
                        配置: apiUrl={fgServiceInfo.apiUrl || '(空)'} | memberId={fgServiceInfo.memberId || '(空)'} | lastNotifId={fgServiceInfo.lastNotifId || '(空)'}
                      </div>
                      <pre style={{ color: '#d4d4d4', whiteSpace: 'pre-wrap', margin: 0, fontSize: 10, lineHeight: 1.4 }}>
                        {fgServiceInfo.logs || '(无日志，服务可能未启动)'}
                      </pre>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* AI Analysis Loader */}
      {showAnalysisLoader && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40">
          <div className="bg-white rounded-2xl p-8 max-w-md w-full flex flex-col items-center">
            <div className="w-16 h-16 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mb-6"></div>
            {queueStatus.inQueue ? (
              <>
                <h3 className="text-xl font-bold text-gray-900 mb-2">正在排队中</h3>
                <p className="text-gray-600 text-center">
                  当前队列位置：<span className="font-bold text-blue-600">第 {queueStatus.queuePosition} 名</span><br/>
                  <span className="text-sm text-gray-500 mt-2 block">系统正在处理您的请求，请稍候...</span>
                </p>
                <button
                  onClick={stopPolling}
                  className="mt-6 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                >
                  取消排队
                </button>
              </>
            ) : (
              <>
                <h3 className="text-xl font-bold text-gray-900 mb-2">正在分析中</h3>
                <p className="text-gray-600 text-center">
                  正在使用 AI 分析数据，请稍候...<br/>
                  <span className="text-sm text-gray-500 mt-2 block">这不是卡顿，AI 正在思考中</span>
                </p>
              </>
            )}
          </div>
        </div>
      )}
      {/* Navbar */}
      <nav className="bg-white/70 backdrop-blur-xl shadow-sm sticky top-0 z-10 border-b border-white/20">
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 text-blue-600 font-bold text-xl">
            <BarChart3 />
            <span>班级评分</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-gray-600 text-sm">
              <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded mr-2">
                {isPublicView ? '公共模式' : maskClassName(currentUser.class)}
              </span>
              {isPublicView ? (
                <span className="font-semibold text-gray-900">正在浏览全校评分</span>
              ) : (
                <>当前用户: <span className="font-semibold text-gray-900">{maskName(currentUser.name)}</span></>
              )}
            </span>
            {!isPublicView && (
              <button
                onClick={() => {
                  fetchMemberDetail(currentUser.id);
                  setIsEditingProfile(true);
                }}
                className="text-blue-600 hover:text-blue-700 text-sm font-medium transition-colors"
              >
                完善个人信息
              </button>
            )}
            {!isPublicView && (
              <button
                onClick={() => {
                  fetchMemberDetail(currentUser.id);
                  fetchExperiences(currentUser.id);
                  setShowExperiencesModal(true);
                }}
                className="text-purple-600 hover:text-purple-700 text-sm font-medium transition-colors"
              >
                我的经历
              </button>
            )}
            {!isPublicView && (
              <button
                onClick={() => {
                  fetchMemberDetail(currentUser.id);
                  setIsEditingProfile(false);
                }}
                className="text-green-600 hover:text-green-700 text-sm font-medium transition-colors"
              >
                查看个人信息
              </button>
            )}
            {(!isPublicView || isAdmin) && (
              <button
                onClick={() => setShowDailyCheckin(true)}
                className="text-sm font-bold text-purple-600 hover:text-purple-700 bg-purple-50 px-3 py-1.5 rounded-lg border border-purple-100 flex items-center gap-1 transition-all shadow-sm"
              >
                <span>📝</span> 速记
              </button>
            )}
            {(!isPublicView || isAdmin) && (
              <button
                onClick={() => setShowDailyQuestion(true)}
                className="text-sm font-bold text-purple-600 hover:text-purple-700 bg-purple-50 px-3 py-1.5 rounded-lg border border-purple-100 flex items-center gap-1 transition-all shadow-sm"
              >
                <span>💡</span> 每日一问
              </button>
            )}
            {isAdmin && (
              <>
                <button
                  onClick={() => setShowAdminCheckin(true)}
                  className="text-sm font-bold text-orange-600 hover:text-orange-700 bg-orange-50 px-3 py-1.5 rounded-lg border border-orange-100 flex items-center gap-1 transition-all shadow-sm"
                >
                  <span>📋</span> 管理记录
                </button>
                <button
                  onClick={() => setShowReportModal(true)}
                  className="text-sm font-bold text-indigo-600 hover:text-indigo-700 bg-indigo-50 px-3 py-1.5 rounded-lg border border-indigo-100 flex items-center gap-1 transition-all shadow-sm"
                >
                  <span>📊</span> 管理日报
                </button>
                <button
                  onClick={() => setShowCalendar(true)}
                  className="text-sm font-bold text-teal-600 hover:text-teal-700 bg-teal-50 px-3 py-1.5 rounded-lg border border-teal-100 flex items-center gap-1 transition-all shadow-sm"
                >
                  <span>📅</span> 日程
                </button>
              </>
            )}
            {currentUser && !isAdmin && currentUser.id !== 'guest' && (
              <>
                <button
                  onClick={() => setShowCalendar(true)}
                  className="text-sm font-bold text-teal-600 hover:text-teal-700 bg-teal-50 px-3 py-1.5 rounded-lg border border-teal-100 flex items-center gap-1 transition-all shadow-sm"
                >
                  <span>📅</span> 日程
                </button>
                <button
                onClick={async () => {
                  setShowNotificationsModal(true);
                  await fetchNotifications(currentUser.id);
                }}
                className="relative text-gray-400 hover:text-blue-500 text-sm transition-colors flex items-center gap-1"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                {unreadCount > 0 && (
                  <span className="absolute -top-2 -right-2 bg-red-500 text-white text-xs rounded-full h-5 w-5 flex items-center justify-center">
                    {unreadCount}
                  </span>
                )}
              </button>
            </>
            )}

            <button 
              onClick={() => {
                setView('login');
                setLoginStep('class');
                setIsPublicView(false);
                setIsAdmin(false);
                setIsSuperAdmin(false);
                setCurrentUser(null);
              }}
              className="text-gray-400 hover:text-red-500 text-sm transition-colors"
            >
              登出
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-5xl mx-auto p-4 md:p-6 space-y-6">
        {/* Navigation Tabs */}
        <div className="flex gap-2 p-1 bg-white/60 backdrop-blur-sm rounded-xl w-fit border border-white/40 shadow-sm">
          <button
            onClick={() => setView('dashboard')}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
              view === 'dashboard' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-600 hover:text-gray-800'
            }`}
          >
            <LayoutDashboard size={16} />
            实时统计
          </button>
          {!isPublicView && (
            <button
              onClick={() => {
                setView('score');
                setTargetMember(currentUser);
                fetchScoredIds(currentUser.id, config.currentWeek);
              }}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
                view === 'score' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-600 hover:text-gray-800'
              }`}
            >
              <Star size={16} />
              评分录入
            </button>
          )}
          {(!isPublicView || isAdmin) && (
            <button
              onClick={() => setView('agent')}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
                view === 'agent' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-600 hover:text-gray-800'
              }`}
            >
              <MessageSquare size={16} />
              AI 助手
            </button>
          )}
        </div>

        {view === 'dashboard' && (
          <div className="flex flex-col lg:flex-row gap-6">
            <div className="w-full lg:w-1/3 order-last lg:order-first space-y-6">
              <div className="bg-white/80 backdrop-blur-sm rounded-xl p-6 shadow-sm border border-white/40 transition-all duration-500 hover:shadow-xl hover:shadow-indigo-100/50 hover:-translate-y-1 hover:border-indigo-200/50" style={{ perspective: '1000px' }}>
                {isPublicView && (
                  <div className="mb-6">
                    <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
                      <LayoutDashboard className="text-blue-500" size={18} />
                      选择班级
                    </h2>
                    <select
                      value={selectedClass}
                      onChange={(e) => {
                        const newClass = e.target.value;
                        setSelectedClass(newClass);
                        const firstMember = members.find(m => m.class === newClass);
                        if (firstMember) {
                          setTargetMember(firstMember);
                          fetchStats(firstMember.id);
                        }
                      }}
                      className="w-full bg-gray-50 border border-gray-200 rounded-lg p-2.5 text-sm font-medium focus:ring-2 focus:ring-blue-500 outline-none"
                    >
                      {classes.map(c => (
                        <option key={c} value={c}>{maskClassName(c)}</option>
                      ))}
                    </select>
                  </div>
                )}
                
                {isPublicView && !isAdmin && (
                  <div className="mb-4 space-y-2">
                    <div className="p-4 bg-teal-50 border border-teal-200 rounded-xl">
                      <h3 className="text-sm font-bold text-teal-700 mb-2">提示</h3>
                      <p className="text-xs text-gray-600">
                        您正在公共模式查看数据。如果需要录入BMI数据，请点击下方按钮（需要验证管理密码）。
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        setShowBMIModal(true);
                        setBmiPassword('');
                        setSelectedBMIWeek(null);
                        setBmiData({});
                        setExpandedBMIClass(null);
                        fetchBMIWeeks();
                      }}
                      className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0-9V5a2 2 0 012-2h6a2 2 0 012 2v5M7 13h4m0 0h4m-4 0v4m0-4V9" />
                      </svg>
                      BMI数据录入
                    </button>

                  </div>
                )}

                {/* 公差计分按钮 - 仅班长可见（在个人主页和公共模式都可见） */}
                {currentUser && isMonitor(currentUser) && (
                  <div className="mb-4 space-y-2">
                    <button
                      onClick={async () => {
                        setDutyForm({
                          memberIds: [],
                          content: '',
                          time: new Date().toISOString().split('T')[0],
                          score: ''
                        });
                        await Promise.all([fetchDuties(), fetchDutyStats()]);
                        setShowDutyModal(true);
                      }}
                      className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 transition-colors"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                      </svg>
                      公差计分
                    </button>
                  </div>
                )}

                {isPublicView && isAdmin && (
                  <div className="mb-4 space-y-2">
                    {/* 心理气象站 */}
                    <button
                      onClick={() => {
                        setShowPsychologicalStationModal(true);
                        setPsychologicalStationTab('alerts');
                        fetchAlerts();
                      }}
                      className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
                    >
                      <HeartPulse size={20} />
                      心理气象站
                    </button>
                    {/* BMI数据展示 */}
                    <button
                      onClick={fetchBMIDisplayData}
                      className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0-9V5a2 2 0 012-2h6a2 2 0 012 2v5M7 13h4m0 0h4m-4 0v4m0-4V9" />
                      </svg>
                      BMI数据一览
                    </button>
                    {/* 周总结功能 */}
                    <button
                      onClick={async () => {
                        await fetchAvailableWeeks();
                        setSelectedSummaryWeek(null);
                        setWeekSummaryData(null);
                        setShowWeekSummaryModal(true);
                      }}
                      className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-pink-600 text-white rounded-lg hover:bg-pink-700 transition-colors"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      周总结
                    </button>
                    {/* 显示当前版本号 */}
                    {currentVersionInfo && (
                      <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl">
                        <h3 className="text-sm font-bold text-blue-700 mb-2">当前应用版本</h3>
                        <div className="space-y-1 text-sm text-gray-700">
                          <p>版本号: <span className="font-medium">{currentVersionInfo.version}</span></p>
                          <p>版本代码: <span className="font-medium">{currentVersionInfo.versionCode}</span></p>
                          {currentVersionInfo.releaseNotes && (
                            <p className="text-xs text-gray-600 mt-1">
                              更新说明: {currentVersionInfo.releaseNotes}
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                    {isSuperAdmin && (
                      <>
                        <button
                          onClick={() => {
                            setWeekInput(config.currentWeek.toString());
                            setShowMaintenanceModal(true);
                          }}
                          className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition-colors"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          </svg>
                          维护
                        </button>
                        <button
                          onClick={() => {
                            setEditScoreWeek(config.currentWeek);
                            setShowEditScoreModal(true);
                          }}
                          className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 transition-colors"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                          修改评分
                        </button>
                        <button
                          onClick={() => {
                            setEditBMIWeek(config.currentWeek);
                            fetchBMIByWeek(config.currentWeek).then(data => {
                              setEditBMIAllData(data || {});
                              setShowEditBMIModal(true);
                            });
                          }}
                          className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                          修改BMI
                        </button>
                        <button
                          onClick={() => {
                            setShowRankUploadModal(true);
                          }}
                          className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0-9V5a2 2 0 012-2h6a2 2 0 012 2v5M7 13h4m0 0h4m-4 0v4m0-4V9" />
                          </svg>
                          上传成绩排名
                        </button>
                        <button
                          onClick={() => {
                            setUploadType('academic');
                            setShowUploadModal(true);
                          }}
                          className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                          </svg>
                          上传学习成绩
                        </button>
                        <button
                          onClick={() => {
                            setUploadType('fitness');
                            setShowUploadModal(true);
                          }}
                          className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                          </svg>
                          上传体能成绩
                        </button>
                        <button
                          onClick={() => {
                            setWeeklyReportFile(null);
                            setWeeklyReportResult(null);
                            setShowWeeklyReportUpload(true);
                          }}
                          className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                          </svg>
                          上传每周通报
                        </button>
                        <button
                          onClick={() => {
                            setApkVersion('1.0.0');
                            setApkVersionCode('1');
                            setApkUpdateRequired(false);
                            setApkReleaseNotes('');
                            setApkFile(null);
                            setShowApkUploadModal(true);
                          }}
                          className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                          </svg>
                          应用更新
                        </button>
                        {/* 设置版本号按钮仅在开发环境显示 */}
                        {/* 设置版本号按钮仅在浏览器开发环境显示，不在手机应用中显示 */}
                        {(!window.Capacitor || window.Capacitor?.platform === 'web') && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && (
                          <button
                            onClick={() => {
                              setApkVersion(currentVersionInfo?.version || '1.0.0');
                              setApkVersionCode(currentVersionInfo?.versionCode?.toString() || '1');
                              setApkUpdateRequired(currentVersionInfo?.updateRequired || false);
                              setApkReleaseNotes(currentVersionInfo?.releaseNotes || '');
                              setShowSetVersionModal(true);
                            }}
                            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
                          >
                            <Settings size={20} />
                            设置版本号
                          </button>
                        )}
                      </>
                    )}
                    {/* BMI数据录入 - 普通管理员也可以使用 */}
                    <button
                      onClick={() => {
                        setShowBMIModal(true);
                        setBmiPassword('');
                        setSelectedBMIWeek(null);
                        setBmiData({});
                        setExpandedBMIClass(null);
                        fetchBMIWeeks();
                      }}
                      className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0-9V5a2 2 0 012-2h6a2 2 0 012 2v5M7 13h4m0 0h4m-4 0v4m0-4V9" />
                      </svg>
                      BMI数据录入
                    </button>
                    {/* 心理数据修改 */}
                    <button
                      onClick={() => {
                        setPsychologyEditMember(null);
                        setPsychologyEditData({
                          positiveNominations: [],
                          negativeNominations: [],
                          moodTag: null,
                          selfAssessment: null
                        });
                        setPsychologyEditType('all');
                        setPsychologyEditPositiveClass(null);
                        setPsychologyEditNegativeClass(null);
                        setShowPsychologyEditModal(true);
                      }}
                      className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-pink-600 text-white rounded-lg hover:bg-pink-700 transition-colors"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                      </svg>
                      修改心理数据
                    </button>
                    <button
                      onClick={() => {
                        fetchClassList();
                        setSelectedClassForManagement(null);
                        setClassMembers([]);
                        setSelectedNewMonitor(null);
                        setClassManagementPassword('');
                        setShowClassManagementModal(true);
                      }}
                      className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                      </svg>
                      班级管理
                    </button>
                    <button
                      onClick={() => setShowSetPasswordModal(true)}
                      className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                      </svg>
                      设置管理密码
                    </button>
                    <button
                      onClick={() => {
                        fetchMakeupPeriods();
                        // 设置默认截止时间为2天后
                        const twoDaysLater = new Date();
                        twoDaysLater.setDate(twoDaysLater.getDate() + 2);
                        twoDaysLater.setHours(23, 59, 59, 0);
                        setNewMakeupEndTime(twoDaysLater.toISOString().slice(0, 16));
                        setNewMakeupWeek(Math.max(1, config.currentWeek - 1));
                        setShowMakeupModal(true);
                      }}
                      className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      补评管理
                    </button>
                  </div>
                )}
                
                {/* 通报功能 - 所有公共模式用户可见 */}
                {isPublicView && (
                  <div className="mb-4">
                    <button
                      onClick={() => {
                        if (!isAdmin) {
                          setNoticePassword('');
                          setShowNoticePasswordModal(true);
                        } else {
                          setNoticeForm({
                            class: targetMember?.class || selectedClass || '',
                            memberId: targetMember?.id || '',
                            content: '',
                            time: new Date().toISOString().split('T')[0]
                          });
                          setShowNoticeModal(true);
                        }
                      }}
                      className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      通报
                    </button>
                    <button
                      onClick={openWeeklyReportViewer}
                      className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition-colors mt-2"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      每周通报情况
                    </button>
                  </div>
                )}

                <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
                  <User className="text-blue-500" size={18} />
                  查看成员
                </h2>
                <div className="space-y-2 max-h-[500px] overflow-y-auto pr-2 custom-scrollbar">
                  {members
                    .filter(m => m.class === (isPublicView ? selectedClass : currentUser.class))
                    .map(m => (
                      <button
                        key={m.id}
                        onClick={() => {
                          setTargetMember(m);
                          fetchStats(m.id);
                          fetchTargetMemberDuties(m.id);
                        }}
                        className={`w-full text-left p-3 rounded-lg text-sm transition-all flex justify-between items-center ${
                          targetMember?.id === m.id ? 'bg-blue-600 text-white' : 'hover:bg-gray-100 text-gray-700'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span>{maskName(m.name)} {m.id === currentUser.id && '(我)'}</span>
                          <div className="flex items-center gap-1">
                            {(() => {
                              const status = memberStatusMap[m.id];
                              if (!status) return null;
                              return (
                                <>
                                  {status.hasFitnessFail && (
                                    <AlertTriangle size={14} className="text-red-500" />
                                  )}
                                  {status.hasFitnessPass && !status.hasFitnessFail && (
                                    <CheckCircle2 size={14} className="text-green-500" />
                                  )}
                                  {status.hasInjury && (
                                    <HeartPulse size={14} className="text-orange-500" />
                                  )}
                                  {status.hasScoreDecline && (
                                    <TrendingDown size={14} className="text-purple-500" />
                                  )}
                                  {status.hasScoreProgress && (
                                    <TrendingUp size={14} className="text-blue-500" />
                                  )}
                                </>
                              );
                            })()}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              fetchMemberDetail(m.id);
                              setIsEditingProfile(false);
                            }}
                            className="text-xs px-2 py-0.5 bg-gray-200 hover:bg-gray-300 rounded transition-colors"
                          >
                            详情
                          </button>
                          {!isPublicView && scoredMemberIds.includes(m.id) && (
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${
                              targetMember?.id === m.id ? 'bg-white text-blue-600' : 'bg-green-100 text-green-700'
                            }`}>
                              已评
                            </span>
                          )}
                        </div>
                      </button>
                    ))}
                </div>
              </div>
            </div>

            <div className="w-full lg:w-2/3 space-y-6">
              <div className="bg-white/80 backdrop-blur-sm rounded-xl p-6 shadow-sm border border-white/40 transition-all duration-500 hover:shadow-xl hover:shadow-indigo-100/50 hover:-translate-y-1 hover:border-indigo-200/50">
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-xl font-bold">
                    {maskName(targetMember?.name)} 的评分数据
                  </h2>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 text-sm text-gray-500 bg-gray-100 px-3 py-1 rounded-full">
                      <Clock size={14} />
                      数据实时更新中
                    </div>
                    {/* AI分析按钮 - 管理员可以分析任何人，个人用户只能分析自己 */}
                    {(isAdmin || (currentUser && targetMember && currentUser.id === targetMember.id)) && (
                      <>
                        <button
                          onClick={() => {
                            const memberToAnalyze = isAdmin ? targetMember : currentUser;
                            if (memberToAnalyze) {
                              setPendingAnalysisMemberId(memberToAnalyze.id);
                              setAnalysisNote('');
                              setShowAnalysisNoteModal(true);
                            }
                          }}
                          disabled={analysisLoading || !(isAdmin || (currentUser && targetMember && currentUser.id === targetMember.id))}
                          className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {analysisLoading ? (
                            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                          ) : (
                            <User size={16} />
                          )}
                          AI 分析
                        </button>
                        {isAdmin && (
                          <button
                            onClick={analyzeAll}
                            disabled={analysisLoading}
                            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {analysisLoading ? (
                              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                            ) : (
                              <Star size={16} />
                            )}
                            分析全体
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* 伤病号文件上传和列表 */}
                {targetMember && (() => {
                  const status = memberStatusMap[targetMember.id];
                  const isInjury = status?.hasInjury;
                  
                  // 计算当前用户可以查看的文件
                  const viewableFiles = memberFiles.filter(file => {
                    return isAdmin || (currentUser && file.uploaderId === currentUser.id);
                  });
                  
                  if (!isInjury && viewableFiles.length === 0) return null;
                  
                  return (
                    <div className="mb-6 bg-white rounded-xl p-4 shadow-sm border-2 border-orange-200">
                      <h3 className="text-lg font-bold text-orange-700 mb-4 flex items-center gap-2">
                        <HeartPulse size={20} className="text-orange-500" />
                        伤病号文件
                      </h3>
                      
                      {/* 上传按钮 */}
                      {isInjury && (isAdmin || (currentUser?.id === targetMember?.id)) && (
                        <div className="mb-4">
                          <label className="flex items-center justify-center gap-2 px-4 py-3 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors cursor-pointer shadow-lg">
                            {uploadingFile ? (
                              <>
                                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                                上传中...
                              </>
                            ) : (
                              <>
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                                </svg>
                                上传病例/诊断结果
                              </>
                            )}
                            <input
                              type="file"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file && targetMember) {
                                  uploadMemberFile(targetMember.id, file);
                                }
                              }}
                              disabled={uploadingFile}
                              accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.md,.html,.xml,.json,.js,.zip,.rar,.7z,.rtf,.mp4,.webm,.ogg,.mov,.avi,.mkv"
                            />
                          </label>
                        </div>
                      )}
                      
                      {/* 文件列表 */}
                      {viewableFiles.length > 0 && (
                        <div className="space-y-2">
                          {viewableFiles.map((file) => (
                            <div key={file.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-200">
                              <div className="flex items-center gap-3">
                                <div className="flex items-center justify-center w-10 h-10 bg-blue-100 rounded-lg">
                                  {file.mimetype.startsWith('image/') ? (
                                    <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                    </svg>
                                  ) : file.mimetype === 'application/pdf' ? (
                                    <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                    </svg>
                                  ) : (
                                    <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                    </svg>
                                  )}
                                </div>
                                <div>
                                  <p className="font-medium text-gray-800 text-sm">{file.filename}</p>
                                  <p className="text-xs text-gray-500">{formatFileSize(file.size)}</p>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={async () => {
                                    const prepared = await prepareFileForPreview(file.id);
                                    if (prepared) {
                                      setCurrentTempFileName(prepared.tempFileName);
                                      setShowFilePreview({ ...file, tempFileName: prepared.tempFileName });
                                    }
                                  }}
                                  className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                                  title="预览"
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                  </svg>
                                </button>
                                <button
                                  onClick={() => downloadFile(getFullApiUrl(`/api/files/${file.id}/download`), file.filename)}
                                  className="p-2 text-green-600 hover:bg-green-50 rounded-lg transition-colors"
                                  title="下载"
                                >
                                  <Download size={16} />
                                </button>
                                {(isAdmin || (currentUser && file.uploaderId === currentUser.id)) && (
                                  <button
                                    onClick={() => targetMember && deleteMemberFile(file.id, targetMember.id)}
                                    className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                    title="删除"
                                  >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                    </svg>
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {config.semesters && config.semesters.length > 0 && (
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-600">
                        <svg className="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3M4 9h16M6 21h12a2 2 0 002-2V7a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                        学期
                      </span>
                      <div className="relative">
                        <select
                          value={selectedSemesterId || config.currentSemesterId || ''}
                          onChange={(e) => {
                            const sid = Number(e.target.value);
                            setSelectedSemesterId(sid);
                            setSelectedRadarWeek(null);
                            setSelectedRadarMember(null);
                            fetchEntropyWeights(sid);
                            if (targetMember) fetchStats(targetMember.id, sid);
                            if (currentUser && !isPublicView) fetchScoredIds(currentUser.id, selectedWeek, sid);
                          }}
                          className="appearance-none pl-3 pr-8 py-1.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors cursor-pointer"
                        >
                          {config.semesters.map(s => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                              {String(s.id) === String(config.currentSemesterId) ? '（当前）' : ''}
                            </option>
                          ))}
                        </select>
                        <svg className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                    </div>
                  </div>
                )}

                {stats.length > 0 ? (
                  <div className="space-y-6">
                    {(() => {
                      const sortedStats = [...stats].sort((a, b) => a.week - b.week);
                      
                      const getPrevWeekData = (currentWeek) => {
                        const currentIndex = sortedStats.findIndex(s => s.week === currentWeek);
                        return currentIndex > 0 ? sortedStats[currentIndex - 1] : null;
                      };
                      
                      return (
                        <>
                          {/* 管理员模式：可点击展开 */}
                          {isAdmin ? (
                            <>
                              {/* 未选中任何雷达图时：显示双列网格 */}
                              {!selectedRadarWeek && (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                  {[...sortedStats].reverse().map(s => {
                                    const prevWeekData = getPrevWeekData(s.week);
                                    return (
                                      <div key={s.week}
                                           className="border border-gray-100 rounded-xl p-4 bg-gray-50 cursor-pointer hover:shadow-md transition-all duration-300"
                                           onClick={() => {
                                             setSelectedRadarWeek(s.week);
                                             setSelectedRadarMember(null);
                                           }}>
                                        <div className="text-center mb-2">
                                          <p className="text-xs text-gray-500">{getWeekDateRange(s.week)}</p>
                                        </div>
                                        <ReactECharts option={getRadarOption(s, prevWeekData)} style={{ height: '300px' }} />
                                        <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                                          {dimensions.map(d => (
                                            <div key={d.key} className="flex justify-between border-b border-gray-200 py-1">
                                              <span className="text-gray-500">{d.label}</span>
                                              <span className="font-bold text-blue-600">{s.averages[d.key].toFixed(1)}</span>
                                            </div>
                                          ))}
                                        </div>
                                        {!s.isComplete && s.notScoredMembers && s.notScoredMembers.length > 0 && (
                                          <div className="mt-4 p-3 bg-yellow-50 border border-yellow-100 rounded-lg">
                                            <h4 className="text-sm font-bold text-yellow-700 mb-1">未评分成员</h4>
                                            <p className="text-xs text-yellow-600">
                                              {s.notScoredMembers.join('、')}
                                            </p>
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                              
                              {/* 选中雷达图时：只显示选中的那一个，三列布局 */}
                              {selectedRadarWeek && (
                                <div className="animate-fadeIn">
                                  {sortedStats.filter(s => s.week === selectedRadarWeek).map(s => {
                                    const prevWeekData = getPrevWeekData(s.week);
                                    return (
                                      <div key={s.week} 
                                           className="border-2 border-blue-500 rounded-xl p-4 bg-white shadow-lg animate-scaleIn">
                                        <div className="flex items-center justify-between mb-4">
                                          <div>
                                            <p className="text-sm font-bold text-blue-600">{getWeekDateRange(s.week)}</p>
                                          </div>
                                          <button
                                            onClick={() => setSelectedRadarWeek(null)}
                                            className="text-gray-400 hover:text-gray-600 transition-colors"
                                          >
                                            <X size={24} />
                                          </button>
                                        </div>
                                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                                          {/* 左侧：雷达图 */}
                                          <div className="lg:col-span-1">
                                            <ReactECharts option={getRadarOption(s, prevWeekData)} style={{ height: '300px' }} />
                                            <div className="mt-4 grid grid-cols-1 gap-1 text-xs">
                                              {dimensions.map(d => (
                                                <div key={d.key} className="flex justify-between border-b border-gray-200 py-1">
                                                  <span className="text-gray-500">{d.label}</span>
                                                  <span className="font-bold text-blue-600">{s.averages[d.key].toFixed(1)}</span>
                                                </div>
                                              ))}
                                            </div>
                                          </div>
                                          
                                          {/* 中间：成员选择器 */}
                                          <div className="lg:col-span-1 max-h-[500px] overflow-y-auto">
                                            <h4 className="text-sm font-bold text-gray-700 mb-2">成员列表</h4>
                                            <div className="space-y-1">
                                              {s.details?.map((detail, index) => {
                                                const member = members.find(m => m.id === detail.memberId);
                                                return (
                                                  <button
                                                    key={index}
                                                    onClick={() => setSelectedRadarMember(detail)}
                                                    className={`w-full text-left px-2 py-1.5 rounded text-xs transition-all duration-200 ${
                                                      selectedRadarMember?.memberId === detail.memberId
                                                        ? 'bg-blue-100 text-blue-700 font-medium'
                                                        : 'hover:bg-gray-100 text-gray-700'
                                                    }`}
                                                  >
                                                    {maskName(member?.name || detail.name)}
                                                  </button>
                                                );
                                              })}
                                            </div>
                                          </div>
                                          
                                          {/* 右侧：树状图显示详细评分 */}
                                          <div className="lg:col-span-1 max-h-[500px] overflow-y-auto">
                                            <h4 className="text-sm font-bold text-gray-700 mb-2">详细评分</h4>
                                            {selectedRadarMember ? (
                                              <div className="text-[10px] space-y-1 animate-fadeIn">
                                                <div className="flex items-center gap-1 mb-2">
                                                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${selectedRadarMember.type === 'self' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                                                    {selectedRadarMember.type === 'self' ? '自评' : '他评'}
                                                  </span>
                                                  <span className="font-medium text-gray-800 text-[11px]">{maskName(selectedRadarMember.name)}</span>
                                                </div>
                                                
                                                {/* 树状图结构 */}
                                                <div className="space-y-1">
                                                  {dimensions.map(dim => (
                                                    <div key={dim.key} className="border-l-2 border-gray-300 pl-2 ml-1">
                                                      <div className="flex items-center justify-between">
                                                        <span className="font-medium text-gray-700">{dim.label}</span>
                                                        <span className="font-bold text-blue-600">{selectedRadarMember.scores[dim.key]?.toFixed(1) || '-'}</span>
                                                      </div>
                                                      {/* 二级评分 */}
                                                      {selectedRadarMember.subItemScores && (
                                                        <div className="mt-1 space-y-0.5 ml-2 border-l border-gray-200 pl-2">
                                                          {dim.subItems.map(subItem => {
                                                            const scoreKey = `${dim.key}_${subItem.key}`;
                                                            const score = selectedRadarMember.subItemScores[scoreKey];
                                                            if (score === undefined || score === null) return null;
                                                            return (
                                                              <div key={scoreKey} className="flex justify-between items-center">
                                                                <span className="text-gray-600">{subItem.label}</span>
                                                                <span className="text-gray-700">{score}/{subItem.maxScore}</span>
                                                              </div>
                                                            );
                                                          })}
                                                        </div>
                                                      )}
                                                    </div>
                                                  ))}
                                                </div>
                                              </div>
                                            ) : (
                                              <div className="text-center py-8 text-gray-400 text-xs">
                                                请选择成员查看详细评分
                                              </div>
                                            )}
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </>
                          ) : (
                            /* 非管理员模式：只显示双列网格，不可点击 */
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                              {[...sortedStats].reverse().map(s => {
                                const prevWeekData = getPrevWeekData(s.week);
                                return (
                                  <div key={s.week} className="border border-gray-100 rounded-xl p-4 bg-gray-50">
                                    <div className="text-center mb-2">
                                      <p className="text-xs text-gray-500">{getWeekDateRange(s.week)}</p>
                                    </div>
                                    <ReactECharts option={getRadarOption(s, prevWeekData)} style={{ height: '300px' }} />
                                    <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                                      {dimensions.map(d => (
                                        <div key={d.key} className="flex justify-between border-b border-gray-200 py-1">
                                          <span className="text-gray-500">{d.label}</span>
                                          <span className="font-bold text-blue-600">{s.averages[d.key].toFixed(1)}</span>
                                        </div>
                                      ))}
                                    </div>
                                    {!s.isComplete && s.notScoredMembers && s.notScoredMembers.length > 0 && (
                                      <div className="mt-4 p-3 bg-yellow-50 border border-yellow-100 rounded-lg">
                                        <h4 className="text-sm font-bold text-yellow-700 mb-1">未评分成员</h4>
                                        <p className="text-xs text-yellow-600">
                                          {s.notScoredMembers.join('、')}
                                        </p>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                ) : (
                  <div className="text-center py-20 text-gray-400">
                    <LayoutDashboard size={48} className="mx-auto mb-4 opacity-20" />
                    暂无评分数据，请先进行评分
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {view === 'score' && (() => {
          // 评分时间检查：周日18:00-24:00（北京时间）
          const now = new Date();
          const beijingTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
          const dayOfWeek = beijingTime.getDay(); // 0=周日
          const hours = beijingTime.getHours();
          const minutes = beijingTime.getMinutes();
          const isSunday = dayOfWeek === 0;
          const isInTimeWindow = isSunday && hours >= 18 && hours < 24;
          
          // 是否是补评（补评不受限制）
          const isMakeupScoring = availableScoringWeeks?.length > 0 && 
            availableScoringWeeks.some(w => w.isMakeup && w.week === selectedWeek);
          
          const isScoringAllowed = isInTimeWindow || isMakeupScoring;

          if (!isScoringAllowed) {
            return (
              <div className="max-w-2xl mx-auto">
                {/* 周次选择器始终可操作 */}
                <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-200 mb-4">
                  <div className="flex items-center gap-4">
                    <label className="text-sm font-bold text-blue-700 whitespace-nowrap">评分周次</label>
                    <select
                      value={selectedWeek}
                      onChange={(e) => setSelectedWeek(parseInt(e.target.value))}
                      className="w-full bg-white border border-blue-200 rounded-md px-3 py-2 text-sm text-gray-700 font-bold focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      {availableScoringWeeks?.length > 0 && availableScoringWeeks.map(w => (
                        <option key={`${w.week}-${w.isMakeup}`} value={w.week}>
                          第 {w.week} 周 {w.isMakeup ? '(补评)' : '(当前周)'} {w.description ? `- ${w.description}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  {availableScoringWeeks?.length > 0 && availableScoringWeeks.some(w => w.isMakeup && w.week === selectedWeek) && (
                    <div className="p-3 bg-orange-50 border border-orange-200 rounded-lg mt-3">
                      <p className="text-sm font-bold text-orange-800">补评模式 — 不受评分时间限制</p>
                      <p className="text-xs text-orange-600">您正在对第 {selectedWeek} 周进行补评，请确保评分准确反映当周情况</p>
                    </div>
                  )}
                </div>
                {/* 虚化的评分内容 */}
                <div className="relative">
                  <div className="bg-white/80 backdrop-blur-sm rounded-xl p-8 shadow-sm border border-white/40 filter blur-sm pointer-events-none select-none opacity-30">
                    <h2 className="text-2xl font-bold mb-2">评分录入</h2>
                    <p className="text-gray-500 mb-8">您正在为 同学 进行 自评 (第 {selectedWeek} 周)</p>
                    <div className="space-y-8">
                      {dimensions.map(d => (
                        <div key={d.key} className="p-4 bg-gray-50 rounded-lg">
                          <p className="font-bold text-gray-700">{d.label}</p>
                          <p className="text-sm text-gray-400">{d.description}</p>
                        </div>
                      ))}
                    </div>
                    <div className="mt-6 p-4 bg-blue-50 rounded-lg">
                      <button className="px-6 py-3 bg-blue-600 text-white rounded-lg">提交评分</button>
                    </div>
                  </div>
                  {/* 虚化遮罩上的提示 */}
                  <div className="absolute inset-0 flex items-center justify-center z-10">
                    <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md mx-4 text-center border border-gray-200">
                      <div className="text-5xl mb-4">⏰</div>
                      <h3 className="text-xl font-bold text-gray-800 mb-3">评分时间未到</h3>
                      <p className="text-gray-600 leading-relaxed">
                        每周评分时间为<br/>
                        <span className="text-lg font-bold text-blue-600">周日 18:00 至 24:00</span><br/>
                      </p>
                      <p className="text-sm text-red-500 mt-3">请在规定时间内进行评分</p>
                      <p className="text-xs text-gray-400 mt-3">或切换到补评周次继续评分</p>
                    </div>
                  </div>
                </div>
              </div>
            );
          }

          return (
          <div className="max-w-2xl mx-auto">
            <div className="bg-white/80 backdrop-blur-sm rounded-xl p-8 shadow-sm border border-white/40 transition-all duration-500 hover:shadow-xl hover:shadow-indigo-100/50 hover:-translate-y-1">
              <h2 className="text-2xl font-bold mb-2">评分录入</h2>
              <p className="text-gray-500 mb-8 flex items-center gap-2">
                您正在为 <span className="font-bold text-blue-600">{maskName(targetMember?.name)}</span> 
                进行 {currentUser.id === targetMember?.id ? '自评' : '他评'} (第 {selectedWeek} 周)
                {scoredMemberIds.includes(targetMember?.id) ? (
                  <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded-full text-xs font-bold flex items-center gap-1">
                    <Star size={12} fill="currentColor" /> 已完成评分
                  </span>
                ) : (
                  <span className="bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full text-xs font-bold">
                    尚未评分
                  </span>
                )}
              </p>

              <div className="space-y-8">
                <div className="flex items-center gap-4 p-4 bg-blue-50 rounded-lg">
                  <label className="text-sm font-bold text-blue-700 whitespace-nowrap">评分周次</label>
                  <select
                    value={selectedWeek}
                    onChange={(e) => setSelectedWeek(parseInt(e.target.value))}
                    className="w-full bg-white border border-blue-200 rounded-md px-3 py-2 text-sm text-gray-700 font-bold focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {availableScoringWeeks?.length > 0 && availableScoringWeeks.map(w => (
                      <option key={`${w.week}-${w.isMakeup}`} value={w.week}>
                        第 {w.week} 周 {w.isMakeup ? '(补评)' : '(当前周)'} {w.description ? `- ${w.description}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
                {/* 补评提示 */}
                {availableScoringWeeks?.length > 0 && availableScoringWeeks.some(w => w.isMakeup && w.week === selectedWeek) && (
                  <div className="p-4 bg-orange-50 border border-orange-200 rounded-lg">
                    <div className="flex items-start gap-2">
                      <AlertTriangle size={20} className="text-orange-600 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-bold text-orange-800">补评模式</p>
                        <p className="text-xs text-orange-600">
                          您正在对第 {selectedWeek} 周进行补评，请确保评分准确反映当周情况
                        </p>
                        {availableScoringWeeks?.length > 0 && availableScoringWeeks.find(w => w.week === selectedWeek)?.endTime && (
                          <p className="text-xs text-orange-600 mt-1">
                            补评截止时间: {new Date(availableScoringWeeks.find(w => w.week === selectedWeek).endTime).toLocaleString('zh-CN')}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                
                {/* 辅助填写功能控制面板 */}
                <div className="space-y-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <label className="text-sm font-bold text-gray-700">辅助填写模式</label>
                      <button
                        onClick={async () => {
                          const newState = !assistModeEnabled;
                          setAssistModeEnabled(newState);
                          if (newState && targetMember) {
                            setLoadingLastWeekScores(true);
                            try {
                              const [data, consecutiveData] = await Promise.all([
                                fetchLastWeekSubScores(targetMember.id),
                                fetchConsecutiveWeeksScores(targetMember.id)
                              ]);
                              // 自动应用上周评分
                              if (data && data.subItemScores) {
                                setSubItemScores({ ...data.subItemScores });
                              }
                            } finally {
                              setLoadingLastWeekScores(false);
                            }
                          }
                        }}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          assistModeEnabled ? 'bg-blue-600' : 'bg-gray-300'
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            assistModeEnabled ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>
                  </div>
                  {assistModeEnabled && (
                    <div className="text-sm text-gray-600">
                      {lastWeekSubScores ? (
                        <p className="text-green-600 flex items-center gap-1">
                          <CheckCircle2 size={16} />
                          已自动应用第 {lastWeekSubScores.week} 周的评分数据，请根据实际情况调整
                        </p>
                      ) : (
                        <p className="text-orange-600 flex items-center gap-1">
                          <AlertTriangle size={16} />
                          暂无上周评分数据，请手动评分
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <div className="space-y-6">
                  <div className="flex items-center gap-4 mb-4">
                    <label className="text-sm font-bold text-gray-700 whitespace-nowrap">评价对象</label>
                    <select
                      value={targetMember?.id}
                      onChange={async (e) => {
                        const member = members.find(m => m.id === e.target.value);
                        setTargetMember(member);
                        if (member) {
                          fetchTargetMemberDuties(member.id);
                          // 如果启用了辅助填写模式，自动加载并应用上周评分
                          if (assistModeEnabled) {
                            setLoadingLastWeekScores(true);
                            try {
                              const [data, consecutiveData] = await Promise.all([
                                fetchLastWeekSubScores(member.id),
                                fetchConsecutiveWeeksScores(member.id)
                              ]);
                              // 自动应用上周评分
                              if (data && data.subItemScores) {
                                setSubItemScores({ ...data.subItemScores });
                              }
                            } finally {
                              setLoadingLastWeekScores(false);
                            }
                          }
                        }
                        // 清除警告
                        setScoreWarnings([]);
                      }}
                      className="w-full bg-white border border-gray-300 rounded-md px-3 py-2 text-sm"
                    >
                      {members
                        .filter(m => m.class === currentUser.class)
                        .map(m => {
                          const isScored = scoredMemberIds.includes(m.id);
                          return (
                            <option key={m.id} value={m.id}>
                              {maskName(m.name)} {m.id === currentUser.id && '(自评)'} {isScored ? '✅ 已评分' : '⏳ 未评分'}
                            </option>
                          );
                        })}
                    </select>
                  </div>

                  {dimensions.map(dim => {
                    const dimensionScore = getDimensionScores()[dim.key];
                    
                    return (
                      <div key={dim.key} className="space-y-4 border border-gray-200 rounded-xl p-4 bg-gray-50">
                        <div className="flex justify-between items-center pb-2 border-b border-gray-200">
                          <div className="flex items-center gap-2">
                            <label className="font-bold text-gray-800 text-lg">{dim.label}</label>
                            {dim.key === 'contribution' && targetMember && (() => {
                              const startDateStr = config.startDate || '2026-03-02T00:00:00+08:00';
                              const currentWeek = config.currentWeek || getCurrentWeekNumber();
                              
                              // 获取当前周的公差
                              const currentWeekDuties = targetMemberDuties.filter(duty => {
                                const dutyWeek = calculateWeek(new Date(duty.time), startDateStr);
                                return dutyWeek === currentWeek;
                              });
                              
                              const dutyCount = currentWeekDuties.reduce((sum, duty) => sum + (duty.count || 1), 0);
                              const totalScore = currentWeekDuties.reduce((sum, duty) => sum + (duty.score || 0), 0);
                              
                              if (dutyCount > 0) {
                                return (
                                  <span className="text-xs font-medium text-teal-600 bg-teal-50 px-2 py-1 rounded-full">
                                    公差: {dutyCount}次{totalScore > 0 ? `, 共${totalScore}分` : ''}
                                  </span>
                                );
                              }
                              return null;
                            })()}
                          </div>
                          <span className="text-blue-600 font-bold text-xl">{dimensionScore}分</span>
                        </div>
                        
                        {dim.subItems.map(subItem => {
                          const scoreKey = `${dim.key}_${subItem.key}`;
                          // 获取上周评分作为参考
                          const lastWeekScore = lastWeekSubScores?.subItemScores?.[scoreKey];
                          return (
                            <div key={subItem.key} className="space-y-2">
                              <div className="flex justify-between items-center">
                                <span className="font-medium text-gray-700">{subItem.label}</span>
                                <div className="flex items-center gap-2">
                                  {assistModeEnabled && lastWeekScore !== undefined && (
                                    <span className="text-xs text-gray-400">
                                      上周: {lastWeekScore}
                                    </span>
                                  )}
                                  <span className="text-blue-600 font-bold">{subItemScores[scoreKey] || subItem.minScore}分 / {subItem.maxScore}分</span>
                                </div>
                              </div>
                              <input
                                type="range"
                                min={subItem.minScore}
                                max={subItem.maxScore}
                                step={0.5}
                                value={subItemScores[scoreKey] || subItem.minScore}
                                onChange={(e) => {
                                  const newScores = { ...subItemScores, [scoreKey]: parseFloat(e.target.value) };
                                  setSubItemScores(newScores);
                                }}
                                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                              />
                              <div className="text-xs text-gray-500 bg-white p-3 rounded-lg border border-gray-100">
                                {subItem.criteria}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>

                {/* 关系提名、心情标签、心理自评 - 仅在自评时显示，且补评时不显示 */}
                {targetMember?.id === currentUser.id && availableScoringWeeks?.length > 0 && availableScoringWeeks.find(w => w.week === selectedWeek)?.isMakeup !== true && (
                <div className="space-y-6 pt-4 border-t border-gray-200">
                  <div className="p-4 bg-purple-50 rounded-lg border border-purple-200">
                    <div className="flex items-center gap-2 mb-2">
                      <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                      </svg>
                      <h3 className="font-bold text-purple-800">关系提名</h3>
                    </div>
                    <p className="text-xs text-purple-600 mb-4">
                      💡 所有提名将匿名提交，仅用于班级社交关系分析
                    </p>
                    
                    {/* 正向提名 */}
                    <div className="mb-6">
                      <label className="block text-sm font-bold text-green-700 mb-2 flex items-center gap-2">
                        <CheckCircle2 size={16} />
                        正向提名（想和谁一组，与谁在一起最舒服）
                      </label>
                      {/* 班级选择 */}
                      <div className="mb-3">
                        <select
                          value={positiveNominationClass || ''}
                          onChange={(e) => setPositiveNominationClass(e.target.value || null)}
                          className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                        >
                          <option value="">-- 选择班级 --</option>
                          {classes.map(c => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </div>
                      {/* 成员选择 */}
                      <div className="flex flex-wrap gap-2">
                        {members
                          .filter(m => {
                            if (!positiveNominationClass) return m.id !== currentUser.id;
                            return m.class === positiveNominationClass && m.id !== currentUser.id;
                          })
                          .map(member => (
                            <button
                              key={member.id}
                              onClick={() => {
                                if (positiveNominations.includes(member.id)) {
                                  setPositiveNominations(positiveNominations.filter(id => id !== member.id));
                                } else {
                                  setPositiveNominations([...positiveNominations, member.id]);
                                }
                              }}
                              className={`px-3 py-1.5 rounded-full text-sm transition-all ${
                                positiveNominations.includes(member.id)
                                  ? 'bg-green-600 text-white'
                                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                              }`}
                            >
                              {maskName(member.name)} <span className="text-xs opacity-70">({member.class})</span>
                            </button>
                          ))}
                        {positiveNominationClass && members.filter(m => m.class === positiveNominationClass && m.id !== currentUser.id).length === 0 && (
                          <p className="text-sm text-gray-500 w-full">该班级暂无其他成员</p>
                        )}
                        {!positiveNominationClass && (
                          <p className="text-xs text-gray-500 w-full">请先选择班级</p>
                        )}
                      </div>
                    </div>
                    
                    {/* 反向提名 */}
                    <div>
                      <label className="block text-sm font-bold text-red-700 mb-2 flex items-center gap-2">
                        <AlertTriangle size={16} />
                        反向提名（和谁相处消耗能量）
                      </label>
                      {/* 班级选择 */}
                      <div className="mb-3">
                        <select
                          value={negativeNominationClass || ''}
                          onChange={(e) => setNegativeNominationClass(e.target.value || null)}
                          className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                        >
                          <option value="">-- 选择班级 --</option>
                          {classes.map(c => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </div>
                      {/* 成员选择 */}
                      <div className="flex flex-wrap gap-2">
                        {members
                          .filter(m => {
                            if (!negativeNominationClass) return m.id !== currentUser.id;
                            return m.class === negativeNominationClass && m.id !== currentUser.id;
                          })
                          .map(member => (
                            <button
                              key={member.id}
                              onClick={() => {
                                if (negativeNominations.includes(member.id)) {
                                  setNegativeNominations(negativeNominations.filter(id => id !== member.id));
                                } else {
                                  setNegativeNominations([...negativeNominations, member.id]);
                                }
                              }}
                              className={`px-3 py-1.5 rounded-full text-sm transition-all ${
                                negativeNominations.includes(member.id)
                                  ? 'bg-red-600 text-white'
                                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                              }`}
                            >
                              {maskName(member.name)} <span className="text-xs opacity-70">({member.class})</span>
                            </button>
                          ))}
                        {negativeNominationClass && members.filter(m => m.class === negativeNominationClass && m.id !== currentUser.id).length === 0 && (
                          <p className="text-sm text-gray-500 w-full">该班级暂无其他成员</p>
                        )}
                        {!negativeNominationClass && (
                          <p className="text-xs text-gray-500 w-full">请先选择班级</p>
                        )}
                      </div>
                    </div>
                  </div>
                  
                  {/* 心情标签 */}
                  <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                    <div className="flex items-center gap-2 mb-4">
                      <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <h3 className="font-bold text-blue-800">本周心情标签</h3>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {moodTags.map((tag) => (
                        <button
                          key={tag}
                          onClick={() => setSelectedMoodTag(selectedMoodTag === tag ? null : tag)}
                          className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                            selectedMoodTag === tag
                              ? 'bg-blue-600 text-white shadow-md'
                              : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50'
                          }`}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                    {moodTags.length === 0 && (
                      <p className="text-sm text-gray-500">加载中...</p>
                    )}
                  </div>

                  {/* 心理状态自评 */}
                  <div className="p-4 bg-purple-50 rounded-lg border border-purple-200">
                    <div className="flex items-center gap-2 mb-4">
                      <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      <h3 className="font-bold text-purple-800">心理状态自评</h3>
                      <span className="text-xs text-purple-500 ml-2">（本周）</span>
                    </div>
                    
                    {/* 评分项目 */}
                    <div className="space-y-4">
                      {/* 睡眠质量 */}
                      <div>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="text-gray-600">睡眠质量</span>
                          <span className="text-purple-600 font-medium">{selfAssessment.sleepQuality}分</span>
                        </div>
                        <input
                          type="range"
                          min="1"
                          max="10"
                          value={selfAssessment.sleepQuality}
                          onChange={(e) => setSelfAssessment({...selfAssessment, sleepQuality: parseInt(e.target.value)})}
                          className="w-full h-2 bg-purple-200 rounded-lg appearance-none cursor-pointer"
                        />
                        <div className="flex justify-between text-xs text-gray-400 mt-1">
                          <span>很差</span><span>很好</span>
                        </div>
                      </div>

                      {/* 情绪状态 */}
                      <div>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="text-gray-600">情绪状态</span>
                          <span className="text-purple-600 font-medium">{selfAssessment.emotionalState}分</span>
                        </div>
                        <input
                          type="range"
                          min="1"
                          max="10"
                          value={selfAssessment.emotionalState}
                          onChange={(e) => setSelfAssessment({...selfAssessment, emotionalState: parseInt(e.target.value)})}
                          className="w-full h-2 bg-purple-200 rounded-lg appearance-none cursor-pointer"
                        />
                        <div className="flex justify-between text-xs text-gray-400 mt-1">
                          <span>很低落</span><span>很愉悦</span>
                        </div>
                      </div>

                      {/* 压力感受 */}
                      <div>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="text-gray-600">压力感受</span>
                          <span className="text-purple-600 font-medium">{selfAssessment.stressLevel}分</span>
                        </div>
                        <input
                          type="range"
                          min="1"
                          max="10"
                          value={selfAssessment.stressLevel}
                          onChange={(e) => setSelfAssessment({...selfAssessment, stressLevel: parseInt(e.target.value)})}
                          className="w-full h-2 bg-purple-200 rounded-lg appearance-none cursor-pointer"
                        />
                        <div className="flex justify-between text-xs text-gray-400 mt-1">
                          <span>无压力</span><span>压力很大</span>
                        </div>
                      </div>

                      {/* 食欲状况 */}
                      <div>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="text-gray-600">食欲状况</span>
                          <span className="text-purple-600 font-medium">{selfAssessment.appetiteLevel}分</span>
                        </div>
                        <input
                          type="range"
                          min="1"
                          max="10"
                          value={selfAssessment.appetiteLevel}
                          onChange={(e) => setSelfAssessment({...selfAssessment, appetiteLevel: parseInt(e.target.value)})}
                          className="w-full h-2 bg-purple-200 rounded-lg appearance-none cursor-pointer"
                        />
                        <div className="flex justify-between text-xs text-gray-400 mt-1">
                          <span>食欲不振</span><span>食欲很好</span>
                        </div>
                      </div>

                      {/* 社交关系评分 */}
                      <div>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="text-gray-600">与室友关系</span>
                          <span className="text-purple-600 font-medium">{selfAssessment.roommateRelation}分</span>
                        </div>
                        <input
                          type="range"
                          min="1"
                          max="10"
                          value={selfAssessment.roommateRelation}
                          onChange={(e) => setSelfAssessment({...selfAssessment, roommateRelation: parseInt(e.target.value)})}
                          className="w-full h-2 bg-purple-200 rounded-lg appearance-none cursor-pointer"
                        />
                      </div>

                      {/* 应对方式 */}
                      <div>
                        <span className="text-sm text-gray-600 block mb-2">遇到困扰时的应对方式（可多选）</span>
                        <div className="flex flex-wrap gap-2">
                          {copingOptions.map((option) => (
                            <button
                              key={option}
                              onClick={() => {
                                const newCoping = selfAssessment.copingStyle.includes(option)
                                  ? selfAssessment.copingStyle.filter(c => c !== option)
                                  : [...selfAssessment.copingStyle, option];
                                setSelfAssessment({...selfAssessment, copingStyle: newCoping});
                              }}
                              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                                selfAssessment.copingStyle.includes(option)
                                  ? 'bg-purple-600 text-white shadow-md'
                                  : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
                              }`}
                            >
                              {option}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                )}

                <button
                  onClick={submitScore}
                  className="w-full bg-blue-600 text-white font-bold py-4 rounded-xl hover:bg-blue-700 transition-colors shadow-lg shadow-blue-200 mt-8"
                >
                  提交评分
                </button>
                <div className="mt-4 p-4 bg-purple-50 rounded-xl border border-purple-100 cursor-pointer hover:bg-purple-100 transition-colors" onClick={() => setShowWeeklyNote(true)}>
                  <div className="text-sm font-medium text-purple-700">✍️ 记录本周的一句话</div>
                  <div className="text-xs text-purple-500 mt-1">花10秒回顾这一周</div>
                </div>
              </div>
            </div>
          </div>
        )})()}

        {view === 'agent' && (!isPublicView || isAdmin) && (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 40 }}>
            <ChatContainer memberId={currentUser?.id} onBack={() => { setView('dashboard'); setPendingAgentContext(null); }} isAdmin={isAdmin} initialContext={pendingAgentContext} />
          </div>
        )}
      </main>

      {/* Analysis Modal */}
      {showAnalysisModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 className="text-xl font-bold text-gray-900">
                {isPublicView ? '全体数据分析报告' : `${maskName(targetMember?.name)} 的分析报告`}
              </h2>
              <div className="flex items-center gap-3">
                <button
                  onClick={downloadWord}
                  className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  下载 Word
                </button>
                <button
                  onClick={() => setShowAnalysisModal(false)}
                  className="text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-6" ref={analysisRef} onScroll={(e) => {
              const { scrollTop, scrollHeight, clientHeight } = e.target;
              const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
              analysisAutoScroll.current = isAtBottom;
            }}>
              {analysisLoading && !analysisResult && (
                <div className="flex items-center gap-2 text-gray-400">
                  <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce"></div>
                  <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                  <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                  <span className="ml-2 text-sm">等待AI响应...</span>
                </div>
              )}
              <div className="prose prose-blue max-w-none">
                {(analysisResult || '').split('\n').map((line, index) => {
                  if (line.startsWith('# ')) {
                    return <h1 key={index} className="text-2xl font-bold text-gray-900 mt-6 mb-4">{line.substring(2)}</h1>;
                  } else if (line.startsWith('## ')) {
                    return <h2 key={index} className="text-xl font-semibold text-gray-800 mt-5 mb-3">{line.substring(3)}</h2>;
                  } else if (line.startsWith('### ')) {
                    return <h3 key={index} className="text-lg font-medium text-gray-700 mt-4 mb-2">{line.substring(4)}</h3>;
                  } else if (line.startsWith('- ')) {
                    return (
                      <ul key={index} className="list-disc list-inside mb-2">
                        <li className="text-gray-700">{line.substring(2)}</li>
                      </ul>
                    );
                  } else if (line.startsWith('  - ')) {
                    return (
                      <ul key={index} className="list-disc list-inside mb-2 ml-4">
                        <li className="text-gray-700">{line.substring(4)}</li>
                      </ul>
                    );
                  } else if (line.trim() !== '') {
                    return <p key={index} className="text-gray-700 mb-3 whitespace-pre-wrap">{line}</p>;
                  }
                  return null;
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Notifications Modal */}
      {showNotificationsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40">
          <div className="bg-white rounded-2xl p-6 max-w-lg w-full max-h-[80vh] flex flex-col">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-xl font-bold text-gray-900">通知</h3>
              <button
                onClick={() => setShowNotificationsModal(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="text-center py-12 text-gray-500">
                  <svg className="w-16 h-16 mx-auto mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                  </svg>
                  <p>暂无通知</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {notifications.map((notification) => (
                    <div
                      key={notification.id}
                      className={`p-4 rounded-lg border ${notification.read ? 'bg-gray-50 border-gray-200' : 'bg-blue-50 border-blue-200'}`}
                      onClick={() => {
                        if (!notification.read) {
                          markNotificationRead(notification.id);
                        }
                      }}
                    >
                      <div className="flex justify-between items-start">
                        <div className="flex-1">
                          <h4 className={`font-semibold ${notification.read ? 'text-gray-700' : 'text-blue-900'}`}>
                            {notification.title}
                          </h4>
                          <p className={`text-sm mt-1 ${notification.read ? 'text-gray-600' : 'text-blue-800'}`}>
                            {notification.body}
                          </p>
                          <p className="text-xs text-gray-400 mt-2">
                            {new Date(notification.sentAt).toLocaleString('zh-CN')}
                          </p>
                        </div>
                        {!notification.read && (
                          <div className="w-2 h-2 bg-blue-500 rounded-full ml-2 flex-shrink-0"></div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Analysis Note Modal */}
      {showAnalysisNoteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40">
          <div className="bg-white rounded-2xl p-6 max-w-lg w-full">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-xl font-bold text-gray-900">AI分析补充说明</h3>
              <button
                onClick={() => {
                  setShowAnalysisNoteModal(false);
                  setAnalysisNote('');
                  setPendingAnalysisMemberId(null);
                }}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            <div className="mb-4">
              <p className="text-sm text-gray-600 mb-3">
                请输入您希望AI在分析时重点关注的内容，如：
              </p>
              <ul className="text-sm text-gray-500 mb-4 list-disc list-inside space-y-1">
                <li>重点分析方向</li>
                <li>特别关注的问题</li>
                <li>想了解的具体方面</li>
              </ul>
              <textarea
                value={analysisNote}
                onChange={(e) => setAnalysisNote(e.target.value)}
                placeholder="例如：重点分析该成员的学习习惯和时间管理能力，或者关注他与同学的协作表现..."
                rows={4}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 resize-none"
              />
              <p className="text-xs text-gray-400 mt-2">可以不填写，直接点击"开始分析"跳过</p>
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowAnalysisNoteModal(false);
                  setAnalysisNote('');
                  setPendingAnalysisMemberId(null);
                }}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => executeAnalysis(pendingAnalysisMemberId)}
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
              >
                开始分析
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Member Detail Modal */}
      {showMemberDetailModal && selectedMemberDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 className="text-xl font-bold text-gray-900">
                {maskName(selectedMemberDetail.member.name)} 的详细信息
              </h2>
              <button
                onClick={() => setShowMemberDetailModal(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              <div className="space-y-6">
                {!isEditingProfile ? (
                  <div className="grid grid-cols-2 gap-4">
                    {/* 只有查看自己的信息时或管理员才显示身高、体重、MBTI和生日 */}
                    {(currentUser?.id === selectedMemberDetail.member.id || isAdmin) && (
                      <>
                        <div className="p-4 bg-gray-50 rounded-xl">
                          <label className="text-sm text-gray-500 mb-1 block">身高</label>
                          <p className="px-3 py-2 text-lg font-medium text-gray-900">{(() => {
                            let heightDisplay = '-';
                            // 优先使用 fixed_heights.json
                            if (fixedHeights[selectedMemberDetail?.member?.id]) {
                              heightDisplay = `${fixedHeights[selectedMemberDetail.member.id]} cm`;
                            } else if (selectedMemberDetail?.fitnessScores?.[0]) {
                              // 回退到 fitnessScores
                              const fitnessData = selectedMemberDetail.fitnessScores[0];
                              let history = fitnessData.history || [];
                              let latestScores = {};
                              if (history.length === 0 && fitnessData.scores) {
                                latestScores = fitnessData.scores;
                              } else if (history.length > 0) {
                                const latestHistory = [...history].sort((a, b) => b.month.localeCompare(a.month))[0];
                                latestScores = latestHistory.scores;
                              }
                              if (latestScores['身高']) {
                                let h = parseFloat(latestScores['身高']);
                                if (!isNaN(h) && h > 0) {
                                  if (h < 3) h = h * 100;
                                  heightDisplay = `${Math.round(h)} cm`;
                                }
                              }
                            }
                            return heightDisplay;
                          })()}</p>
                          <p className="text-xs text-gray-400 mt-1">来源：{fixedHeights[selectedMemberDetail?.member?.id] ? '固定身高数据' : '体测数据'}</p>
                        </div>
                        <div className="p-4 bg-gray-50 rounded-xl">
                          <label className="text-sm text-gray-500 mb-1 block">体重</label>
                          <p className="px-3 py-2 text-lg font-medium text-gray-900">{selectedMemberDetail.member.weight ? `${selectedMemberDetail.member.weight} kg` : '-'}</p>
                          <p className="text-xs text-gray-400 mt-1">来源：BMI数据录入</p>
                        </div>
                        <div 
                          className="p-4 bg-gray-50 rounded-xl cursor-pointer hover:bg-gray-100 transition-colors"
                          onClick={() => selectedMemberDetail.member.mbti && setShowMBTIDetail(selectedMemberDetail.member.mbti.toUpperCase())}
                        >
                          <label className="text-sm text-gray-500 mb-1 block">MBTI</label>
                          <p className="px-3 py-2 text-lg font-medium text-gray-900">
                            {selectedMemberDetail.member.mbti ? selectedMemberDetail.member.mbti.toUpperCase() : '-'}
                          </p>
                          {selectedMemberDetail.member.mbti && MBTI_DATA[selectedMemberDetail.member.mbti.toUpperCase()] && (
                            <p className="text-xs text-blue-600 mt-1">
                              {MBTI_DATA[selectedMemberDetail.member.mbti.toUpperCase()].name}
                            </p>
                          )}
                        </div>
                        <div className="p-4 bg-gray-50 rounded-xl">
                          <label className="text-sm text-gray-500 mb-1 block">生日</label>
                          <p className="px-3 py-2 text-lg font-medium text-gray-900">{selectedMemberDetail.member.birthday || '-'}</p>
                          {selectedMemberDetail.member.zodiac && (
                            <p className="text-xs text-purple-600 mt-1">星座：{selectedMemberDetail.member.zodiac}</p>
                          )}
                        </div>
                        <div className="p-4 bg-gray-50 rounded-xl">
                          <label className="text-sm text-gray-500 mb-1 block">骨干</label>
                          <p className="px-3 py-2 text-lg font-medium text-gray-900">
                            {selectedMemberDetail.member.isBackbone ? '是' : '否'}
                          </p>
                          {selectedMemberDetail.member.position && (
                            <p className="text-xs text-orange-600 mt-1">岗位：{selectedMemberDetail.member.position}</p>
                          )}
                        </div>
                        {selectedMemberDetail.member.hobbies && (
                          <div className="p-4 bg-gray-50 rounded-xl md:col-span-2">
                            <label className="text-sm text-gray-500 mb-1 block">兴趣爱好</label>
                            <p className="px-3 py-2 text-lg font-medium text-gray-900">{selectedMemberDetail.member.hobbies}</p>
                          </div>
                        )}
                        {selectedMemberDetail.member.hometown && (
                          <div className="p-4 bg-gray-50 rounded-xl">
                            <label className="text-sm text-gray-500 mb-1 block">籍贯</label>
                            <p className="px-3 py-2 text-lg font-medium text-gray-900">{selectedMemberDetail.member.hometown}</p>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ) : null}
                
                {/* 只有查看自己的信息时才显示编辑MBTI和生日 */}
                {currentUser?.id === selectedMemberDetail.member.id && isEditingProfile && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="p-4 bg-gray-50 rounded-xl">
                      <label className="text-sm text-gray-500 mb-1 block">MBTI</label>
                      <input
                        type="text"
                        value={profileFormData.mbti}
                        onChange={(e) => setProfileFormData({ ...profileFormData, mbti: e.target.value })}
                        placeholder="如：INTJ"
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div className="p-4 bg-gray-50 rounded-xl">
                      <label className="text-sm text-gray-500 mb-1 block">生日</label>
                      <input
                        type="date"
                        value={profileFormData.birthday}
                        onChange={(e) => setProfileFormData({ ...profileFormData, birthday: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div className="p-4 bg-gray-50 rounded-xl">
                      <label className="text-sm text-gray-500 mb-1 block">骨干</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          id="isBackbone"
                          checked={profileFormData.isBackbone}
                          onChange={(e) => setProfileFormData({ ...profileFormData, isBackbone: e.target.checked })}
                          className="w-4 h-4 text-orange-600 rounded focus:ring-orange-500"
                        />
                        <label htmlFor="isBackbone" className="text-sm text-gray-700">
                          是否为骨干
                        </label>
                      </div>
                    </div>
                    <div className="p-4 bg-gray-50 rounded-xl">
                      <label className="text-sm text-gray-500 mb-1 block">岗位</label>
                      <input
                        type="text"
                        value={profileFormData.position}
                        onChange={(e) => setProfileFormData({ ...profileFormData, position: e.target.value })}
                        placeholder="请输入岗位"
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                      />
                    </div>
                    <div className="p-4 bg-gray-50 rounded-xl md:col-span-2">
                      <label className="text-sm text-gray-500 mb-1 block">兴趣爱好</label>
                      <textarea
                        value={profileFormData.hobbies}
                        onChange={(e) => setProfileFormData({ ...profileFormData, hobbies: e.target.value })}
                        placeholder="请输入兴趣爱好，如：阅读、运动、音乐等"
                        rows={2}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                      />
                    </div>
                    <div className="p-4 bg-gray-50 rounded-xl">
                      <label className="text-sm text-gray-500 mb-1 block">籍贯</label>
                      <input
                        type="text"
                        value={profileFormData.hometown}
                        onChange={(e) => setProfileFormData({ ...profileFormData, hometown: e.target.value })}
                        placeholder="如：四川成都"
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                )}

                {/* BMI部分，去掉条件限制 */}
                <div
                  id="bmi-section"
                  className="p-4 bg-blue-50 border border-blue-100 rounded-xl cursor-pointer hover:bg-blue-100 transition-colors"
                  onClick={async () => {
                    // 获取所有BMI录入数据
                    await fetchAllBMIData();
                    setShowAllBMIModal(true);
                  }}
                >
                  <h3 className="text-lg font-bold text-blue-700 mb-2">BMI 指数 <span className="text-xs font-normal text-blue-500">(点击查看变化)</span></h3>
                  {(() => {
                    // 直接使用后端返回的BMI值
                    let bmi = selectedMemberDetail?.member?.bmi ? parseFloat(selectedMemberDetail.member.bmi) : null;
                    
                    // 备选方案：从 allBMIData 中计算BMI
                    if (bmi === null && allBMIData.length > 0) {
                      const memberId = selectedMemberDetail?.member?.id;
                      const memberBMIRecords = allBMIData
                        .filter(r => r.memberId === memberId)
                        .sort((a, b) => (b.week || 0) - (a.week || 0));
                      
                      if (memberBMIRecords.length > 0 && memberBMIRecords[0].weight) {
                        const height = fixedHeights[memberId];
                        if (height && height > 0) {
                          const weight = parseFloat(memberBMIRecords[0].weight);
                          if (!isNaN(weight) && weight > 0) {
                            bmi = (weight / ((height / 100) * (height / 100))).toFixed(2);
                            bmi = parseFloat(bmi);
                          }
                        }
                      }
                    }

                    const isFemale = isFemaleMember(selectedMemberDetail.member?.id);
                    const minBMI = 18.5;
                    const maxBMI = isFemale ? 23.9 : 25.9;
                    
                    return (
                      <>
                        <p className="text-3xl font-bold text-blue-600">
                          {bmi !== null ? bmi : '-'}
                        </p>
                        {bmi !== null && (
                          <>
                            {(() => {
                              const isPass = bmi >= minBMI && bmi <= maxBMI;
                              const category = bmi < 18.5 ? '偏瘦' : bmi <= maxBMI ? '正常' : bmi < 28 ? '偏胖' : '肥胖';
                              return (
                                <>
                                  <p className="text-sm text-blue-600 mt-1">{category}</p>
                                  <p className={`text-sm font-bold mt-2 ${isPass ? 'text-green-600' : 'text-red-600'}`}>
                                    {isPass ? `✓ 及格 (18.5-${maxBMI})` : '✗ 不及格'}
                                  </p>
                                </>
                              );
                            })()}
                          </>
                        )}
                      </>
                    );
                  })()}
                </div>



                {currentUser?.id === selectedMemberDetail.member.id && isEditingProfile && (
                  <div className="flex justify-end gap-3">
                    <button
                      onClick={() => {
                        setIsEditingProfile(false);
                        setProfileFormData({
                          mbti: selectedMemberDetail.member.mbti || '',
                          birthday: selectedMemberDetail.member.birthday || '',
                          isBackbone: selectedMemberDetail.member.isBackbone || false,
                          position: selectedMemberDetail.member.position || '',
                          hobbies: selectedMemberDetail.member.hobbies || '',
                          hometown: selectedMemberDetail.member.hometown || ''
                        });
                      }}
                      className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                    >
                      取消
                    </button>
                    <button
                      onClick={handleProfileSubmit}
                      className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                    >
                      保存
                    </button>
                  </div>
                )}

                {!isEditingProfile && (
                  <>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {/* 学习成绩 */}
                    <button
                      onClick={async () => {
                        if (selectedMemberDetail?.member?.id) {
                          await Promise.all([
                            fetchMemberLastWeekSubScores(selectedMemberDetail.member.id),
                            fetchExperiences(selectedMemberDetail.member.id)
                          ]);
                        }
                        setShowAcademicModal(true);
                      }}
                      className="p-4 bg-blue-50 hover:bg-blue-100 rounded-xl border border-blue-200 transition-colors text-left"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-2xl">📚</span>
                        {academicScoresDisplay.failCount > 0 && (
                          <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded-full text-xs font-bold">
                            {academicScoresDisplay.failCount}科
                          </span>
                        )}
                      </div>
                      <h4 className="font-bold text-blue-800">学习成绩</h4>
                      <p className="text-sm text-blue-600 mt-1">
                        平均分: {academicScoresDisplay.averageScore}
                      </p>
                    </button>

                    {/* 体能素质 */}
                    <button
                      onClick={async () => {
                        if (selectedMemberDetail?.member?.id) {
                          await fetchMemberLastWeekSubScores(selectedMemberDetail.member.id);
                        }
                        setShowFitnessModal(true);
                      }}
                      className="p-4 bg-green-50 hover:bg-green-100 rounded-xl border border-green-200 transition-colors text-left"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-2xl">🏃</span>
                        {(fitnessScoresDisplay.hasFail || fitnessScoresDisplay.hasUnreference) && (
                          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                            fitnessScoresDisplay.hasFail ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'
                          }`}>
                            {fitnessScoresDisplay.hasFail ? '不及格' : '伤病号'}
                          </span>
                        )}
                      </div>
                      <h4 className="font-bold text-green-800">体能素质</h4>
                      <p className="text-sm text-green-600 mt-1">
                        {selectedMemberDetail?.fitnessScores?.[0]?.averages?.fitness?.toFixed(1) || '-'}
                      </p>
                    </button>

                    {/* 人文素养 */}
                    <button
                      onClick={async () => {
                        if (selectedMemberDetail?.member?.id) {
                          await Promise.all([
                            fetchMemberLastWeekSubScores(selectedMemberDetail.member.id),
                            fetchExperiences(selectedMemberDetail.member.id)
                          ]);
                        }
                        setShowLiteracyModal(true);
                      }}
                      className="p-4 bg-purple-50 hover:bg-purple-100 rounded-xl border border-purple-200 transition-colors text-left"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-2xl">📖</span>
                      </div>
                      <h4 className="font-bold text-purple-800">人文素养</h4>
                      <p className="text-sm text-purple-600 mt-1">
                        {selectedMemberDetail?.fitnessScores?.[0]?.averages?.reading?.toFixed(1) || '-'}
                      </p>
                    </button>

                    {/* 遵章守纪 */}
                    <button
                      onClick={async () => {
                        if (selectedMemberDetail?.member?.id) {
                          await fetchMemberLastWeekSubScores(selectedMemberDetail.member.id);
                          try {
                            const res = await axios.get(getFullApiUrl(`/api/discipline-scores/${selectedMemberDetail.member.id}`));
                            setDisciplineScores(prev => ({ ...prev, [selectedMemberDetail.member.id]: res.data.totalScore }));
                          } catch {}
                        }
                        setShowDisciplineModal(true);
                      }}
                      className="p-4 bg-red-50 hover:bg-red-100 rounded-xl border border-red-200 transition-colors text-left"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-2xl">⚖️</span>
                        {disciplineScores[selectedMemberDetail?.member?.id] !== undefined && (
                          <span className={`text-lg font-bold ${disciplineScores[selectedMemberDetail.member.id] >= 80 ? 'text-green-600' : 'text-red-600'}`}>
                            {disciplineScores[selectedMemberDetail.member.id].toFixed(1)}
                          </span>
                        )}
                      </div>
                      <h4 className="font-bold text-red-800">遵章守纪</h4>
                      <p className="text-sm text-red-600 mt-1">
                        {selectedMemberDetail?.fitnessScores?.[0]?.averages?.queue?.toFixed(1) || '-'}
                      </p>
                    </button>

                    {/* 班级贡献 */}
                    <button
                      onClick={async () => {
                        if (selectedMemberDetail?.member?.id) {
                          await fetchMemberLastWeekSubScores(selectedMemberDetail.member.id);
                        }
                        setShowContributionModal(true);
                      }}
                      className="p-4 bg-teal-50 hover:bg-teal-100 rounded-xl border border-teal-200 transition-colors text-left"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-2xl">🤝</span>
                      </div>
                      <h4 className="font-bold text-teal-800">班级贡献</h4>
                      <p className="text-sm text-teal-600 mt-1">
                        {selectedMemberDetail?.fitnessScores?.[0]?.averages?.work?.toFixed(1) || '-'}
                      </p>
                    </button>

                    {/* 管理能力 */}
                    <button
                      onClick={async () => {
                        if (selectedMemberDetail?.member?.id) {
                          await Promise.all([
                            fetchMemberLastWeekSubScores(selectedMemberDetail.member.id),
                            fetchExperiences(selectedMemberDetail.member.id)
                          ]);
                        }
                        setShowManagementModal(true);
                      }}
                      className="p-4 bg-orange-50 hover:bg-orange-100 rounded-xl border border-orange-200 transition-colors text-left"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-2xl">📊</span>
                      </div>
                      <h4 className="font-bold text-orange-800">管理能力</h4>
                      <p className="text-sm text-orange-600 mt-1">
                        {selectedMemberDetail?.fitnessScores?.[0]?.averages?.responsibility?.toFixed(1) || '-'}
                      </p>
                    </button>
                  </div>
                  </>
                )}
                
                {/* 文件列表 */}
                {(() => {
                  // 计算当前用户可以查看的文件
                  const viewableFiles = memberFiles.filter(file => {
                    return isAdmin || (currentUser && file.uploaderId === currentUser.id);
                  });
                  
                  if (viewableFiles.length === 0) return null;
                  
                  return (
                    <div className="pt-4 border-t border-gray-200">
                      <h3 className="text-lg font-bold text-gray-800 mb-4">文件列表</h3>
                      <div className="space-y-2">
                        {viewableFiles.map((file) => (
                        <div key={file.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-200">
                          <div className="flex items-center gap-3">
                            <div className="flex items-center justify-center w-10 h-10 bg-blue-100 rounded-lg">
                              {file.mimetype.startsWith('image/') ? (
                                <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                </svg>
                              ) : file.mimetype === 'application/pdf' ? (
                                <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                </svg>
                              ) : (
                                <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                </svg>
                              )}
                            </div>
                            <div>
                              <p className="font-medium text-gray-800 text-sm">{file.filename}</p>
                              <p className="text-xs text-gray-500">{formatFileSize(file.size)}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={async () => {
                                const prepared = await prepareFileForPreview(file.id);
                                if (prepared) {
                                  setCurrentTempFileName(prepared.tempFileName);
                                  setShowFilePreview({ ...file, tempFileName: prepared.tempFileName });
                                }
                              }}
                              className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                              title="预览"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                              </svg>
                            </button>
                            <button
                              onClick={() => downloadFile(getFullApiUrl(`/api/files/${file.id}/download`), file.filename)}
                              className="p-2 text-green-600 hover:bg-green-50 rounded-lg transition-colors"
                              title="下载"
                            >
                              <Download size={16} />
                            </button>
                            {(isAdmin || (currentUser && file.uploaderId === currentUser.id)) && (
                              <button
                                onClick={() => selectedMemberDetail?.member?.id && deleteMemberFile(file.id, selectedMemberDetail.member.id)}
                                className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                title="删除"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  );
                })()}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Set Password Modal */}
      {showSetPasswordModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40">
          <div className="bg-white rounded-2xl p-8 max-w-md w-full">
            <h3 className="text-xl font-bold text-gray-900 mb-4">设置管理密码</h3>
            <label className="block text-sm font-medium text-gray-700 mb-1">新密码</label>
            <input
              type="password"
              value={newPasswordInput}
              onChange={(e) => setNewPasswordInput(e.target.value)}
              placeholder="请输入新密码（至少4位）"
              className="w-full px-4 py-3 border border-gray-300 rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <label className="block text-sm font-medium text-gray-700 mb-1">确认密码</label>
            <input
              type="password"
              value={confirmPasswordInput}
              onChange={(e) => setConfirmPasswordInput(e.target.value)}
              placeholder="请再次输入新密码"
              className="w-full px-4 py-3 border border-gray-300 rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleSetAdminPassword();
                }
              }}
            />
            <div className="flex gap-3">
              <button
                onClick={() => {
                  setShowSetPasswordModal(false);
                  setOldPasswordInput('');
                  setNewPasswordInput('');
                  setConfirmPasswordInput('');
                }}
                className="flex-1 px-4 py-3 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSetAdminPassword}
                className="flex-1 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Upload Modal */}
      {showUploadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 className="text-xl font-bold text-gray-900">上传{uploadType === 'academic' ? '学习成绩' : '体能成绩'}表格</h2>
              <button
                onClick={() => {
                  setShowUploadModal(false);
                  setUploadFile(null);
                }}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-6">
              {uploadType === 'academic' && (
                <p className="text-xs text-blue-500 mb-4">增量更新：新增科目会自动添加，已有科目会覆盖更新</p>
              )}
              {uploadType === 'fitness' && (
                <div className="mb-6">
                  <label className="block text-sm font-medium text-gray-700 mb-2">选择月份</label>
                  <input
                    type="month"
                    value={fitnessMonth}
                    onChange={(e) => setFitnessMonth(e.target.value)}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              )}
              <div 
                className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center hover:border-blue-400 transition-colors"
                onDragOver={(e) => {
                  e.preventDefault();
                  e.currentTarget.classList.add('border-blue-500', 'bg-blue-50');
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  e.currentTarget.classList.remove('border-blue-500', 'bg-blue-50');
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.currentTarget.classList.remove('border-blue-500', 'bg-blue-50');
                  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                    setUploadFile(e.dataTransfer.files[0]);
                  }
                }}
              >
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={(e) => setUploadFile(e.target.files[0])}
                  className="hidden"
                  id="file-upload"
                />
                <label htmlFor="file-upload" className="cursor-pointer">
                  <svg className="w-12 h-12 mx-auto text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  {uploadFile ? (
                    <p className="text-sm text-gray-600 font-medium">{uploadFile.name}</p>
                  ) : (
                    <>
                      <p className="text-sm text-gray-600 mb-2">点击或拖拽文件到此处</p>
                      <p className="text-xs text-gray-400">支持 .xlsx, .xls 格式</p>
                    </>
                  )}
                </label>
              </div>
              <div className="mt-6 flex gap-3">
                <button
                  onClick={() => {
                    setShowUploadModal(false);
                    setUploadFile(null);
                  }}
                  className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleFileUpload}
                  disabled={uploading || !uploadFile}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {uploading ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                      上传中...
                    </>
                  ) : (
                    '上传'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Rank Upload Modal */}
      {showRankUploadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <div>
                <h2 className="text-xl font-bold text-gray-900">上传成绩排名表格</h2>
                <p className="text-xs text-blue-500 mt-1">增量更新：新学期成绩会自动添加，已有学期会覆盖</p>
              </div>
              <button
                onClick={() => {
                  setShowRankUploadModal(false);
                  setRankUploadFile(null);
                }}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            <div className="p-6">
              <div 
                className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center hover:border-purple-400 transition-colors"
                onDragOver={(e) => {
                  e.preventDefault();
                  e.currentTarget.classList.add('border-purple-500', 'bg-purple-50');
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  e.currentTarget.classList.remove('border-purple-500', 'bg-purple-50');
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.currentTarget.classList.remove('border-purple-500', 'bg-purple-50');
                  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                    setRankUploadFile(e.dataTransfer.files[0]);
                  }
                }}
              >
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={(e) => setRankUploadFile(e.target.files[0])}
                  className="hidden"
                  id="rank-upload"
                />
                <label htmlFor="rank-upload" className="cursor-pointer">
                  <svg className="w-12 h-12 mx-auto text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  {rankUploadFile ? (
                    <p className="text-sm text-gray-600 font-medium">{rankUploadFile.name}</p>
                  ) : (
                    <>
                      <p className="text-sm text-gray-600 mb-2">点击或拖拽文件到此处</p>
                      <p className="text-xs text-gray-400">支持 .xlsx, .xls 格式</p>
                    </>
                  )}
                </label>
              </div>
              <div className="mt-6 flex gap-3">
                <button
                  onClick={() => {
                    setShowRankUploadModal(false);
                    setRankUploadFile(null);
                  }}
                  className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleRankUpload}
                  disabled={rankUploading || !rankUploadFile}
                  className="flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {rankUploading ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                      上传中...
                    </>
                  ) : (
                    '上传'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 每周通报上传弹窗 */}
      {showWeeklyReportUpload && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 className="text-xl font-bold text-gray-900">上传每周通报</h2>
              <button
                onClick={() => { setShowWeeklyReportUpload(false); setWeeklyReportFile(null); setWeeklyReportResult(null); }}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {!weeklyReportResult ? (
                <>
                  <p className="text-sm text-gray-500 mb-4">上传Excel通报表格，支持格式：第一行日期范围，第二行表头（日期/姓名宿舍/量化内容/加扣分/备注）</p>
                  <div 
                    className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center hover:border-red-400 transition-colors"
                    onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-red-500','bg-red-50'); }}
                    onDragLeave={(e) => { e.preventDefault(); e.currentTarget.classList.remove('border-red-500','bg-red-50'); }}
                    onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove('border-red-500','bg-red-50'); if (e.dataTransfer.files?.length) setWeeklyReportFile(e.dataTransfer.files[0]); }}
                  >
                    <input
                      type="file" accept=".xlsx,.xls"
                      onChange={(e) => setWeeklyReportFile(e.target.files[0])}
                      className="hidden" id="weekly-report-upload"
                    />
                    <label htmlFor="weekly-report-upload" className="cursor-pointer">
                      <svg className="w-12 h-12 mx-auto text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                      </svg>
                      {weeklyReportFile ? (
                        <p className="text-sm text-gray-600 font-medium">{weeklyReportFile.name}</p>
                      ) : (
                        <>
                          <p className="text-sm text-gray-600 mb-2">点击或拖拽文件到此处</p>
                          <p className="text-xs text-gray-400">支持 .xlsx, .xls 格式</p>
                        </>
                      )}
                    </label>
                  </div>
                  <div className="mt-6 flex gap-3">
                    <button onClick={() => { setShowWeeklyReportUpload(false); setWeeklyReportFile(null); }}
                      className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors">
                      取消
                    </button>
                    <button onClick={handleWeeklyReportUpload} disabled={weeklyReportLoading || !weeklyReportFile}
                      className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50">
                      {weeklyReportLoading ? '上传中...' : '上传解析'}
                    </button>
                  </div>
                </>
              ) : (
                <div>
                  <div className="p-4 bg-green-50 rounded-xl mb-4">
                    <p className="font-medium text-green-800">{weeklyReportResult.message}</p>
                    <p className="text-sm text-green-600 mt-1">周期：{weeklyReportResult.weekRange} | 涉及 {weeklyReportResult.memberCount} 人</p>
                  </div>
                  {weeklyReportResult.fuzzyMatches && weeklyReportResult.fuzzyMatches.length > 0 && (
                    <div className="p-4 bg-yellow-50 rounded-xl mb-4 border border-yellow-200">
                      <h3 className="font-bold text-yellow-800 mb-2">模糊匹配纠正：</h3>
                      {weeklyReportResult.fuzzyMatches.map((fm, i) => (
                        <div key={i} className="flex items-center gap-2 mb-2 p-2 bg-white rounded-lg border border-yellow-300">
                          <span className="text-sm text-yellow-700 flex-shrink-0">
                            「{fm.original}」→
                          </span>
                          <select
                            className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-yellow-500"
                            defaultValue={fm.resolved}
                            onChange={(e) => {
                              const val = e.target.value;
                              if (val === fm.original) return; // 不改
                              // 从 members 中找到 memberId
                              const found = members.find(m => m.name === val);
                              handleCorrectFuzzyMatch(
                                weeklyReportResult.weekRange,
                                fm.original,
                                val,
                                found ? found.id : null
                              );
                            }}
                          >
                            <option value={fm.resolved}>{fm.resolved}</option>
                            <option disabled>──────</option>
                            {members.filter(m => {
                              const n1 = fm.original;
                              const n2 = m.name;
                              if (n1 === n2 || n2 === fm.resolved) return false;
                              if (n1.length !== n2.length) return false;
                              let diff = 0;
                              for (let j = 0; j < n1.length; j++) if (n1[j] !== n2[j]) diff++;
                              return diff <= 2;
                            }).map(m => (
                              <option key={m.id} value={m.name}>{m.name} ({m.class})</option>
                            ))}
                            {members.filter(m => {
                              const n1 = fm.original;
                              const n2 = m.name;
                              if (n1 === n2 || n2 === fm.resolved) return false;
                              if (n1.length === n2.length) {
                                let diff = 0;
                                for (let j = 0; j < n1.length; j++) if (n1[j] !== n2[j]) diff++;
                                if (diff <= 2) return false;
                              }
                              return m.name.includes(fm.original[0]) || fm.original.includes(m.name[0]);
                            }).map(m => (
                              <option key={m.id} value={m.name}>{m.name} ({m.class})</option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  )}
                  {weeklyReportResult.reportText && (
                    <div className="p-4 bg-gray-50 rounded-xl">
                      <h3 className="font-bold text-gray-700 mb-2">生成的通报内容：</h3>
                      <pre className="text-sm text-gray-600 whitespace-pre-wrap font-mono">{weeklyReportResult.reportText}</pre>
                    </div>
                  )}
                  <div className="mt-4 flex gap-3">
                    <button onClick={() => setWeeklyReportResult(null)}
                      className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors">
                      继续上传
                    </button>
                    <button onClick={() => { setShowWeeklyReportUpload(false); setWeeklyReportFile(null); setWeeklyReportResult(null); }}
                      className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
                      完成
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 每周通报查看弹窗 */}
      {showWeeklyReportViewer && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200 bg-gradient-to-r from-orange-500 to-red-500">
              <h2 className="text-xl font-bold text-white">每周通报情况</h2>
              <button onClick={() => { setShowWeeklyReportViewer(false); setWeeklyReportDetail(null); }}
                className="text-white hover:text-gray-200 transition-colors">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {!weeklyReportDetail ? (
                <>
                  {weeklyReportsList.length === 0 ? (
                    <div className="text-center py-12">
                      <p className="text-gray-400 text-lg">暂无通报数据</p>
                      <p className="text-gray-300 text-sm mt-2">请管理员上传通报Excel表格</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-sm text-gray-500 mb-3">请选择要查看的周次：</p>
                      {weeklyReportsList.map(r => (
                        <button key={r.weekRange} onClick={() => fetchWeeklyReportDetail(r.weekRange)}
                          className="w-full p-4 bg-gray-50 hover:bg-orange-50 rounded-xl border border-gray-200 hover:border-orange-300 transition-colors text-left">
                          <p className="font-bold text-gray-800">{r.weekRange}</p>
                          <p className="text-sm text-gray-500 mt-1">{r.itemCount}条记录 | 涉及{r.memberCount}人 | 上传于{new Date(r.uploadTime).toLocaleDateString()}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div>
                  <button onClick={() => setWeeklyReportDetail(null)}
                    className="mb-4 text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1">
                    ← 返回列表
                  </button>
                  <div className="p-4 bg-orange-50 rounded-xl mb-4">
                    <p className="font-bold text-lg text-orange-800">{weeklyReportDetail.weekRange}</p>
                    <p className="text-sm text-orange-600 mt-1">{weeklyReportDetail.items.length}条记录 | 上传于{new Date(weeklyReportDetail.uploadTime).toLocaleDateString()}</p>
                  </div>
                  {weeklyReportDetail.reportText ? (
                    <div className="p-4 bg-gray-50 rounded-xl">
                      <pre className="text-sm text-gray-600 whitespace-pre-wrap font-mono">{weeklyReportDetail.reportText}</pre>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {weeklyReportDetail.items.map((item, idx) => (
                        <div key={idx} className="p-3 bg-red-50 rounded-lg border-l-4 border-red-400">
                          <span className="font-medium text-red-800">{item.date}</span>
                          <span className="mx-2 text-red-600">{item.names?.join('、')}</span>
                          <span className="text-gray-700">{item.content}</span>
                          <span className="ml-2 text-sm text-red-500">{item.score}分{item.perPerson ? '/人' : ''}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="mt-4">
                    <h3 className="font-bold text-gray-700 mb-3">本周计分：</h3>
                    <div className="grid grid-cols-2 gap-2">
                      {Object.entries(weeklyReportDetail.memberScores || {}).map(([key, data]) => (
                        <div key={key} className="p-2 bg-gray-50 rounded-lg flex justify-between">
                          <span className="text-sm text-gray-700">{data.name}</span>
                          <span className={`text-sm font-bold ${data.score >= 80 ? 'text-green-600' : 'text-red-600'}`}>{data.score.toFixed(1)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Maintenance Modal */}
      {showMaintenanceModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h2 className="text-lg font-bold text-gray-900">系统维护</h2>
              <button
                onClick={() => {
                  setShowMaintenanceModal(false);
                  setWeekInput('');
                }}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={20} />
              </button>
            </div>
            <div className="p-4 overflow-y-auto flex-1 space-y-4">
              <div className="space-y-3">
                <div className="p-3 bg-blue-50 border border-blue-100 rounded-lg">
                  <h3 className="text-base font-bold text-blue-700 mb-2">当前信息</h3>
                  <p className="text-sm text-gray-700">
                    当前周次：<span className="font-bold text-blue-600">第 {config.currentWeek} 周</span>
                  </p>
                </div>

                <div className="space-y-2">
                  <h3 className="text-base font-bold text-gray-900">周次管理</h3>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="1"
                      value={weekInput}
                      onChange={(e) => setWeekInput(e.target.value)}
                      placeholder="请输入周次"
                      className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button
                      onClick={updateWeek}
                      className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
                    >
                      确认
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-base font-bold text-gray-900">学期管理</h3>
                    <button
                      onClick={addSemester}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m-7-7h14" />
                      </svg>
                      添加学期
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    {(config.semesters || []).map(s => (
                      <div key={s.id} className="flex items-center gap-2 p-2 rounded-lg border border-gray-100 bg-gray-50/60">
                        <span className="w-14 text-sm font-medium text-gray-700 shrink-0">{s.name}</span>
                        <input
                          type="date"
                          value={((semesterEditMap[s.id] !== undefined ? semesterEditMap[s.id] : s.startDate) || '').slice(0, 10)}
                          onChange={(e) => setSemesterEditMap(prev => ({ ...prev, [s.id]: e.target.value }))}
                          className="flex-1 min-w-0 px-2 py-1.5 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        {String(s.id) === String(config.currentSemesterId) ? (
                          <span className="px-2 py-0.5 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded shrink-0">当前学期</span>
                        ) : (
                          <button
                            onClick={() => switchSemester(s.id)}
                            className="px-2 py-0.5 text-xs font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded hover:bg-blue-100 transition-colors shrink-0"
                          >
                            设为当前
                          </button>
                        )}
                        <button
                          onClick={() => deleteSemester(s.id)}
                          title="删除学期"
                          className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors shrink-0"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={saveSemesters}
                    className="w-full px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
                  >
                    保存学期起点
                  </button>
                </div>

                <div className="space-y-2">
                  <h3 className="text-base font-bold text-gray-900">数据备份</h3>
                  <p className="text-xs text-gray-600">下载所有评分数据和成员信息的压缩备份</p>
                  <button
                    onClick={downloadBackup}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0L8 8m4 4v12" />
                    </svg>
                    下载数据备份
                  </button>
                </div>

                <div className="space-y-2">
                  <h3 className="text-base font-bold text-gray-900">恢复备份</h3>
                  <p className="text-xs text-gray-600">上传备份文件恢复所有数据（将覆盖现有数据！）</p>
                  <div className="space-y-2">
                    <input
                      type="file"
                      accept=".zip"
                      onChange={(e) => setRestoreBackupFile(e.target.files[0])}
                      className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    {restoreBackupFile && (
                      <p className="text-xs text-gray-600">
                        已选择文件：{restoreBackupFile.name}
                      </p>
                    )}
                    <button
                      onClick={async () => {
                        if (!restoreBackupFile) {
                          showNotification('请选择备份文件', 'error');
                          return;
                        }
                        
                        if (confirm('确定要恢复备份吗？这将覆盖所有现有数据，此操作不可恢复！')) {
                          try {
                            setRestoringBackup(true);
                            const formData = new FormData();
                            formData.append('file', restoreBackupFile);
                            
                            const res = await axios.post(getFullApiUrl('/api/restore/backup'), formData, {
                              headers: {
                                'Content-Type': 'multipart/form-data'
                              }
                            });
                            
                            if (res.data.success) {
                              showNotification('备份恢复成功！页面将刷新', 'success');
                              setTimeout(() => {
                                window.location.reload();
                              }, 2000);
                            }
                          } catch (err) {
                            console.error('Failed to restore backup', err);
                            showNotification(err.response?.data?.error || '恢复备份失败', 'error');
                          } finally {
                            setRestoringBackup(false);
                          }
                        }
                      }}
                      disabled={!restoreBackupFile || restoringBackup}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {restoringBackup ? (
                        <>
                          <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                          恢复中...
                        </>
                      ) : (
                        <>
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                          </svg>
                          恢复备份
                        </>
                      )}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <h3 className="text-base font-bold text-gray-900">BMI数据</h3>
                  <p className="text-xs text-gray-600">下载身高体重BMI数据（Excel格式）</p>
                  <button
                    onClick={downloadBMIData}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors font-medium"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0L8 8m4 4v12" />
                    </svg>
                    下载BMI数据
                  </button>
                </div>

                <div className="space-y-2">
                  <h3 className="text-base font-bold text-gray-900">更新公告</h3>
                  <p className="text-xs text-gray-600">修改登录界面显示的更新公告</p>
                  <button
                    onClick={() => {
                      setEditNoticeForm({
                        updateNotice: updateNotices.updateNotice,
                        downloadLink: updateNotices.downloadLink,
                        contact: updateNotices.contact
                      });
                      setShowEditNoticeModal(true);
                    }}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-medium"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                    修改公告
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MBTI详细介绍 Modal */}
      {showMBTIDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">{showMBTIDetail}</h2>
                {MBTI_DATA[showMBTIDetail] && (
                  <p className="text-lg text-gray-600 mt-1">{MBTI_DATA[showMBTIDetail].name}</p>
                )}
              </div>
              <button
                onClick={() => setShowMBTIDetail(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={28} />
              </button>
            </div>
            {MBTI_DATA[showMBTIDetail] && (
              <div className="p-6 overflow-y-auto flex-1 space-y-6">
                {/* 描述 */}
                <div className="bg-blue-50 p-4 rounded-xl border border-blue-100">
                  <h3 className="font-bold text-blue-800 mb-2">类型描述</h3>
                  <p className="text-gray-700">{MBTI_DATA[showMBTIDetail].description}</p>
                </div>
                
                {/* 性格特质 */}
                <div>
                  <h3 className="font-bold text-gray-900 mb-3">性格特质</h3>
                  <div className="flex flex-wrap gap-2">
                    {MBTI_DATA[showMBTIDetail].traits.map((trait, index) => (
                      <span
                        key={index}
                        className="px-3 py-1 bg-purple-100 text-purple-700 rounded-full text-sm font-medium"
                      >
                        {trait}
                      </span>
                    ))}
                  </div>
                </div>
                
                {/* 优势 */}
                <div>
                  <h3 className="font-bold text-gray-900 mb-3">优势</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {MBTI_DATA[showMBTIDetail].strengths.map((strength, index) => (
                      <div
                        key={index}
                        className="flex items-center gap-2 p-3 bg-green-50 rounded-lg"
                      >
                        <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0" />
                        <span className="text-gray-700">{strength}</span>
                      </div>
                    ))}
                  </div>
                </div>
                
                {/* 劣势 */}
                <div>
                  <h3 className="font-bold text-gray-900 mb-3">需要注意的方面</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {MBTI_DATA[showMBTIDetail].weaknesses.map((weakness, index) => (
                      <div
                        key={index}
                        className="flex items-center gap-2 p-3 bg-orange-50 rounded-lg"
                      >
                        <AlertTriangle className="w-5 h-5 text-orange-600 flex-shrink-0" />
                        <span className="text-gray-700">{weakness}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
            <div className="p-6 border-t border-gray-200">
              <button
                onClick={() => setShowMBTIDetail(false)}
                className="w-full px-4 py-3 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors font-medium"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* File Preview Modal */}
      {showFilePreview && (
        <div className="fixed inset-0 z-50 bg-black bg-opacity-80 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-[80vw] h-[80vh] overflow-hidden flex flex-col shadow-2xl">
            <div className="flex justify-between items-center p-4 bg-gray-900 text-white">
              <div>
                <h3 className="text-lg font-bold">{showFilePreview.filename}</h3>
                <p className="text-sm text-gray-400">{formatFileSize(showFilePreview.size)}</p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => downloadFile(getFullApiUrl(`/api/files/${showFilePreview.id}/download`), showFilePreview.filename)}
                  className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                >
                  <Download size={18} />
                  下载
                </button>
                <button
                  onClick={async () => {
                    if (showFilePreview.tempFileName) {
                      await deleteTempFile(showFilePreview.tempFileName);
                    }
                    setShowFilePreview(null);
                    setCurrentTempFileName(null);
                  }}
                  className="text-gray-400 hover:text-white transition-colors p-2"
                >
                  <X size={28} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-hidden bg-gray-100">
              {(() => {
                console.log('Previewing file:', showFilePreview);
                const isImage = showFilePreview.mimetype?.startsWith('image/');
                const isPdf = showFilePreview.mimetype === 'application/pdf';
                const isVideo = showFilePreview.mimetype?.startsWith('video/');
                const isText = showFilePreview.mimetype?.startsWith('text/') ||
                          ['application/json', 'application/javascript'].includes(showFilePreview.mimetype);

                // 在原生移动环境中，PDF文件直接下载并用系统应用打开，不显示预览
                if (isPdf && window.Capacitor?.platform !== 'web') {
                  return (
                    <div className="w-full h-full flex flex-col items-center justify-center bg-gray-900">
                      <div className="text-center text-white">
                        <svg className="w-24 h-24 mx-auto mb-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <p className="text-xl mb-6">PDF文件将在系统PDF阅读器中打开</p>
                        <button
                          onClick={() => downloadFile(getFullApiUrl(`/api/files/${showFilePreview.id}/download`), showFilePreview.filename, true)}
                          className="inline-flex items-center gap-3 px-8 py-4 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors text-lg"
                        >
                          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                          用系统PDF阅读器打开
                        </button>
                      </div>
                    </div>
                  );
                }

                if (isImage && showFilePreview.tempFileName) {
                  return (
                    <img
                      src={getFullApiUrl(`/api/temp-files/${showFilePreview.tempFileName}?preview=true`)}
                      alt={showFilePreview.filename}
                      className="w-full h-full object-contain"
                      onError={(e) => {
                        console.error('Image load error');
                        e.target.style.display = 'none';
                      }}
                    />
                  );
                }

                if (isPdf && showFilePreview.tempFileName) {
                  return (
                    <div className="w-full h-full flex flex-col">
                      {/* PDF页面导航 */}
                      <div className="flex items-center justify-between p-4 bg-gray-800 text-white">
                        <button
                          onClick={() => changePdfPage(-1)}
                          disabled={pdfPageNumber <= 1}
                          className="flex items-center gap-2 px-4 py-2 bg-gray-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-600 transition-colors"
                        >
                          <ChevronLeft size={20} />
                          上一页
                        </button>
                        <span className="text-lg font-medium">
                          第 {pdfPageNumber} 页 / 共 {pdfNumPages || '?'} 页
                        </span>
                        <button
                          onClick={() => changePdfPage(1)}
                          disabled={pdfPageNumber >= (pdfNumPages || 1)}
                          className="flex items-center gap-2 px-4 py-2 bg-gray-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-600 transition-colors"
                        >
                          下一页
                          <ChevronRight size={20} />
                        </button>
                      </div>

                      {/* PDF内容区域 - 使用embed显示PDF */}
                      <div className="flex-1 bg-gray-900 flex items-center justify-center p-4">
                        <embed
                          src={getFullApiUrl(`/api/temp-files/${showFilePreview.tempFileName}?preview=true`)}
                          type="application/pdf"
                          className="w-full h-full"
                          onLoad={(e) => {
                            console.log('PDF loaded successfully');
                            // 尝试获取页数
                            const pdf = e.target;
                            if (pdf && pdf.numPages === undefined) {
                              // 设置默认页数为1
                              setPdfNumPages(1);
                              setPdfLoading(false);
                            }
                          }}
                          onError={(e) => {
                            console.error('PDF load error:', e);
                            setPdfError('PDF加载失败');
                          }}
                        />
                        {pdfLoading && (
                          <div className="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-80">
                            <div className="text-center">
                              <div className="w-16 h-16 border-4 border-gray-600 border-t-blue-500 rounded-full animate-spin mx-auto mb-4"></div>
                              <p className="text-gray-400 text-lg">PDF加载中...</p>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                }
                
                if (isVideo && showFilePreview.tempFileName) {
                  return (
                    <video
                      src={getFullApiUrl(`/api/temp-files/${showFilePreview.tempFileName}?preview=true`)}
                      controls
                      className="w-full h-full object-contain"
                      onError={(e) => {
                        console.error('Video load error');
                      }}
                    />
                  );
                }
                
                if (isText && showFilePreview.tempFileName) {
                  return (
                    <div className="w-full h-full overflow-auto p-6 bg-gray-900">
                      {loadingTextFile ? (
                        <div className="flex items-center justify-center h-full">
                          <div className="text-center">
                            <div className="w-12 h-12 border-4 border-gray-600 border-t-green-500 rounded-full animate-spin mx-auto mb-4"></div>
                            <p className="text-gray-400 text-lg">加载中...</p>
                          </div>
                        </div>
                      ) : (
                        <pre className="text-green-400 font-mono text-base whitespace-pre-wrap leading-relaxed">
                          {textFileContent || '暂无内容'}
                        </pre>
                      )}
                    </div>
                  );
                }
                
                return (
                  <div className="w-full h-full flex items-center justify-center bg-gray-900">
                    <div className="text-center">
                      <svg className="w-24 h-24 text-gray-500 mx-auto mb-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      <p className="text-gray-400 text-xl mb-6">该文件类型不支持预览</p>
                      <button
                        onClick={() => downloadFile(getFullApiUrl(`/api/files/${showFilePreview.id}/download`), showFilePreview.filename)}
                        className="inline-flex items-center gap-3 px-8 py-4 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors text-lg"
                      >
                        <Download size={24} />
                        下载文件
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* APK Upload Modal */}
      {showApkUploadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 className="text-xl font-bold text-gray-900">上传应用更新</h2>
              <button
                onClick={() => setShowApkUploadModal(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  版本号 (如: 1.0.0)
                </label>
                <input
                  type="text"
                  value={apkVersion}
                  onChange={(e) => setApkVersion(e.target.value)}
                  placeholder="1.0.0"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  版本号代码 (数字, 如: 1)
                </label>
                <input
                  type="number"
                  min="1"
                  value={apkVersionCode}
                  onChange={(e) => setApkVersionCode(e.target.value)}
                  placeholder="1"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="updateRequired"
                  checked={apkUpdateRequired}
                  onChange={(e) => setApkUpdateRequired(e.target.checked)}
                  className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                />
                <label htmlFor="updateRequired" className="text-sm text-gray-700">
                  强制更新（用户必须更新后才能使用）
                </label>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  更新说明
                </label>
                <textarea
                  value={apkReleaseNotes}
                  onChange={(e) => setApkReleaseNotes(e.target.value)}
                  placeholder="请输入本次更新的内容说明..."
                  rows={3}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  选择APK文件
                </label>
                <input
                  type="file"
                  accept=".apk"
                  onChange={(e) => setApkFile(e.target.files?.[0] || null)}
                  className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                />
                {apkFile && (
                  <p className="mt-2 text-sm text-green-600">
                    已选择: {apkFile.name} ({(apkFile.size / 1024 / 1024).toFixed(2)} MB)
                  </p>
                )}
              </div>
              <div className="flex gap-3 pt-4">
                <button
                  onClick={() => setShowApkUploadModal(false)}
                  className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleApkUpload}
                  disabled={!apkFile || uploadingApk}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {uploadingApk ? (
                    <>
                      <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                      上传中...
                    </>
                  ) : (
                    '上传'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* BMI数据录入 Modal */}
      {showBMIModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 className="text-xl font-bold text-gray-900">BMI数据录入</h2>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    setShowBMIUploadModal(true);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  上传表格
                </button>
                <button
                  onClick={() => setShowBMIModal(false)}
                  className="text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <X size={24} />
                </button>
              </div>
            </div>
            <div className="p-6 space-y-4 overflow-y-auto flex-1">
              {/* BMI录入密码输入 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  BMI录入密码
                </label>
                <input
                  type="password"
                  value={bmiPassword}
                  onChange={(e) => setBmiPassword(e.target.value)}
                  placeholder="请输入BMI录入密码"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              
              {/* 周数选择 - 日历样式 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  选择周数
                </label>
                <div className="border border-gray-300 rounded-lg p-4 bg-white">
                  {/* 月份导航 */}
                  <div className="flex items-center justify-between mb-4">
                    <button
                      onClick={() => setBmiCalendarMonth(new Date(bmiCalendarMonth.getFullYear(), bmiCalendarMonth.getMonth() - 1))}
                      className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                      </svg>
                    </button>
                    <span className="font-semibold text-gray-800">
                      {bmiCalendarMonth.getFullYear()}年{bmiCalendarMonth.getMonth() + 1}月
                    </span>
                    <button
                      onClick={() => setBmiCalendarMonth(new Date(bmiCalendarMonth.getFullYear(), bmiCalendarMonth.getMonth() + 1))}
                      className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  </div>
                  
                  {/* 星期标题 */}
                  <div className="grid grid-cols-7 gap-1 mb-2">
                    {['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map(day => (
                      <div key={day} className="text-center text-xs font-medium text-gray-500 py-2">
                        {day}
                      </div>
                    ))}
                  </div>
                  
                  {/* 日期网格 */}
                  <div className="grid grid-cols-7 gap-1">
                    {(() => {
                      const year = bmiCalendarMonth.getFullYear();
                      const month = bmiCalendarMonth.getMonth();
                      const firstDay = new Date(year, month, 1);
                      const lastDay = new Date(year, month + 1, 0);
                      
                      // 计算第一周的第一天（周一）
                      let startDate = new Date(firstDay);
                      const dayOfWeek = startDate.getDay();
                      if (dayOfWeek === 0) {
                        startDate.setDate(startDate.getDate() - 6);
                      } else if (dayOfWeek !== 1) {
                        startDate.setDate(startDate.getDate() - (dayOfWeek - 1));
                      }
                      
                      const weeks = [];
                      let currentDate = new Date(startDate);
                      
                      // 生成6周的数据
                      for (let week = 0; week < 6; week++) {
                        const weekDays = [];
                        for (let day = 0; day < 7; day++) {
                          weekDays.push(new Date(currentDate));
                          currentDate.setDate(currentDate.getDate() + 1);
                        }
                        weeks.push(weekDays);
                      }
                      
                      return weeks.map((week, weekIndex) => {
                        const weekStart = week[0];
                        const weekEnd = week[6];
                        
                        // 使用与主系统一致的周次计算方式
                        const startDateStr = config.startDate || '2026-03-02T00:00:00+08:00';
                        const weekNum = calculateWeek(weekEnd, startDateStr);
                        const currentWeek = config.currentWeek || getCurrentWeekNumber();
                        const isCurrentWeek = currentWeek === weekNum;
                        const isSelected = selectedBMIWeek === weekNum;
                        const hasData = bmiWeeks.includes(weekNum);
                        
                        // 检查这一周是否在当前月份内
                        const isInMonth = weekStart.getMonth() === month || weekEnd.getMonth() === month;
                        // 允许选择当前周及所有以往周次
                        const isSelectable = isInMonth && weekNum <= currentWeek;
                        
                        let buttonClass = 'p-2 rounded-lg text-center transition-all relative ';
                        
                        if (!isSelectable) {
                          buttonClass += 'opacity-30 cursor-not-allowed ';
                        } else {
                          buttonClass += 'hover:bg-blue-50 cursor-pointer ';
                        }
                        
                        if (isSelected) {
                          buttonClass += 'bg-blue-600 text-white hover:bg-blue-700 ';
                        } else if (isCurrentWeek) {
                          buttonClass += 'bg-blue-100 text-blue-800 ';
                        } else {
                          buttonClass += 'bg-gray-50 ';
                        }
                        
                        if (hasData) {
                          buttonClass += 'ring-2 ring-green-400 ';
                        }
                        
                        return (
                          <button
                            key={weekIndex}
                            onClick={() => {
                              setSelectedBMIWeek(weekNum);
                              // 先尝试加载缓存
                              const cachedData = loadBMICache(weekNum);
                              if (Object.keys(cachedData).length > 0) {
                                setBmiData(cachedData);
                              } else {
                                fetchBMIByWeek(weekNum);
                              }
                            }}
                            disabled={!isSelectable}
                            className={buttonClass}
                          >
                            <div className="text-xs font-medium">
                              {weekStart.getMonth() + 1}/{weekStart.getDate()}
                            </div>
                            <div className="text-xs opacity-75">
                              第{weekNum}周
                            </div>
                            {hasData && (
                              <div className="absolute top-1 right-1 w-2 h-2 bg-green-500 rounded-full"></div>
                            )}
                          </button>
                        );
                      });
                    })()}
                  </div>
                  
                  {/* 图例 */}
                  <div className="flex items-center gap-4 mt-4 text-xs text-gray-600">
                    <div className="flex items-center gap-1">
                      <div className="w-3 h-3 bg-green-400 rounded"></div>
                      <span>已有数据</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="w-3 h-3 bg-blue-600 rounded"></div>
                      <span>已选中</span>
                    </div>
                  </div>
                  
                  {/* 选中周提示 */}
                  {selectedBMIWeek && (
                    <div className="mt-3 p-2 bg-blue-50 rounded-lg text-center text-sm text-blue-700">
                      已选择：第{selectedBMIWeek}周
                    </div>
                  )}
                </div>
              </div>
              
              {/* 班级和成员列表 */}
              {selectedBMIWeek && (
                <div className="space-y-4">
                  <h3 className="text-lg font-semibold text-gray-900">班级成员</h3>
                  {classes.map(className => {
                    const classMembers = members.filter(m => m.class === className);
                    return (
                      <div key={className} className="border border-gray-200 rounded-lg">
                        <button
                          onClick={() => setExpandedBMIClass(expandedBMIClass === className ? null : className)}
                          className="w-full px-4 py-3 bg-gray-50 flex items-center justify-between hover:bg-gray-100 transition-colors rounded-t-lg"
                        >
                          <span className="font-semibold text-gray-800">{className}</span>
                          <svg
                            className={`w-5 h-5 text-gray-500 transition-transform ${expandedBMIClass === className ? 'rotate-90' : ''}`}
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </button>
                        {expandedBMIClass === className && (
                          <div className="p-4 space-y-3">
                            {classMembers.map(member => {
                              const memberBMI = bmiData[member.id] || {};
                              const fixedHeight = fixedHeights[member.id];
                              const bmi = calculateBMI(fixedHeight, memberBMI.weight);
                              return (
                                <div key={member.id} className="grid grid-cols-1 md:grid-cols-3 gap-3 items-center bg-gray-50 p-3 rounded-lg">
                                  <div className="md:col-span-1">
                                    <span className="font-medium text-gray-800">{member.name}</span>
                                  </div>
                                  <div>
                                    <label className="block text-xs text-gray-500 mb-1">身高(cm) <span className="text-blue-600">(固定)</span></label>
                                    <div className="px-3 py-2 bg-gray-100 border border-gray-200 rounded-lg text-sm">
                                      {fixedHeight || '-'}
                                    </div>
                                  </div>
                                  <div>
                                    <label className="block text-xs text-gray-500 mb-1">体重(kg)</label>
                                    <input
                                      type="number"
                                      step="0.1"
                                      value={memberBMI.weight || ''}
                                      onChange={(e) => {
                                        const newData = { ...bmiData };
                                        if (!newData[member.id]) newData[member.id] = {};
                                        newData[member.id].weight = e.target.value;
                                        setBmiData(newData);
                                      }}
                                      placeholder="70.5"
                                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    />
                                  </div>
                                  <div>
                                    <label className="block text-xs text-gray-500 mb-1">BMI</label>
                                    <div className={`px-3 py-2 border rounded-lg text-sm font-medium ${
                                      bmi ? (
                                        parseFloat(bmi) >= 18.5 && parseFloat(bmi) <= 23.9
                                          ? 'bg-green-50 border-green-300 text-green-800'
                                          : 'bg-yellow-50 border-yellow-300 text-yellow-800'
                                      ) : 'bg-gray-50 border-gray-300 text-gray-400'
                                    }`}>
                                      {bmi || '-'}
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="flex gap-3 p-6 border-t border-gray-200">
              <button
                onClick={() => setShowBMIModal(false)}
                className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
              >
                取消
              </button>
              <button
                onClick={saveBMIData}
                disabled={!selectedBMIWeek || !bmiPassword || savingBMI}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {savingBMI ? (
                  <>
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    保存中...
                  </>
                ) : (
                  '保存'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* BMI数据上传 Modal */}
      {showBMIUploadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 className="text-xl font-bold text-gray-900">上传BMI表格</h2>
              <button
                onClick={() => {
                  setShowBMIUploadModal(false);
                  setBmiUploadFile(null);
                }}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            <div className="p-6 space-y-4 overflow-y-auto flex-1">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  选择周数
                </label>
                <div className="border border-gray-300 rounded-lg p-4 bg-white">
                  {/* 月份导航 */}
                  <div className="flex items-center justify-between mb-4">
                    <button
                      onClick={() => setBmiCalendarMonth(new Date(bmiCalendarMonth.getFullYear(), bmiCalendarMonth.getMonth() - 1))}
                      className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                      </svg>
                    </button>
                    <span className="font-semibold text-gray-800">
                      {bmiCalendarMonth.getFullYear()}年{bmiCalendarMonth.getMonth() + 1}月
                    </span>
                    <button
                      onClick={() => setBmiCalendarMonth(new Date(bmiCalendarMonth.getFullYear(), bmiCalendarMonth.getMonth() + 1))}
                      className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  </div>
                  
                  {/* 星期标题 */}
                  <div className="grid grid-cols-7 gap-1 mb-2">
                    {['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map(day => (
                      <div key={day} className="text-center text-xs font-medium text-gray-500 py-2">
                        {day}
                      </div>
                    ))}
                  </div>
                  
                  {/* 日期网格 */}
                  <div className="grid grid-cols-7 gap-1">
                    {(() => {
                      const year = bmiCalendarMonth.getFullYear();
                      const month = bmiCalendarMonth.getMonth();
                      const firstDay = new Date(year, month, 1);
                      const lastDay = new Date(year, month + 1, 0);
                      
                      // 计算第一周的第一天（周一）
                      let startDate = new Date(firstDay);
                      const dayOfWeek = startDate.getDay();
                      if (dayOfWeek === 0) {
                        startDate.setDate(startDate.getDate() - 6);
                      } else if (dayOfWeek !== 1) {
                        startDate.setDate(startDate.getDate() - (dayOfWeek - 1));
                      }
                      
                      const weeks = [];
                      let currentDate = new Date(startDate);
                      
                      // 生成6周的日期
                      for (let weekNum = 0; weekNum < 6; weekNum++) {
                        const weekDates = [];
                        for (let dayNum = 0; dayNum < 7; dayNum++) {
                          weekDates.push(new Date(currentDate));
                          currentDate.setDate(currentDate.getDate() + 1);
                        }
                        weeks.push({
                          week: weekNum + 1,
                          dates: weekDates
                        });
                      }
                      
                      return weeks.map((weekData, weekIndex) => {
                        const weekStart = weekData.dates[0];
                        const weekEnd = weekData.dates[6];
                        // 使用与主系统一致的周次计算方式
                        const startDateStr = config.startDate || '2026-03-02T00:00:00+08:00';
                        const weekNumber = calculateWeek(weekEnd, startDateStr);
                        const currentWeek = config.currentWeek || getCurrentWeekNumber();
                        const isCurrentWeek = currentWeek === weekNumber;
                        const isSelectable = weekNumber <= currentWeek;
                        const isSelected = selectedBMIWeek === weekNumber;
                        
                        return (
                          <div key={weekNumber} className="col-span-7">
                            <div className="flex justify-between items-center mb-1">
                              <span className="text-xs font-medium text-gray-500">第{weekNumber}周</span>
                              {isCurrentWeek && (
                                <span className="text-xs text-blue-600 font-medium">当前周</span>
                              )}
                            </div>
                            <div className="grid grid-cols-7 gap-1">
                              {weekData.dates.map((date, dayIndex) => {
                                const isSameMonth = date.getMonth() === month;
                                const isToday = date.toDateString() === new Date().toDateString();
                                
                                return (
                                  <button
                                    key={dayIndex}
                                    onClick={() => {
                                      setSelectedBMIWeek(weekNumber);
                                    }}
                                    disabled={!isSelectable}
                                    className={`h-10 flex items-center justify-center text-xs rounded-lg transition-colors ${
                                      isSelected
                                        ? 'bg-blue-600 text-white'
                                        : isCurrentWeek
                                        ? 'bg-blue-500 text-white'
                                        : isSameMonth
                                        ? 'hover:bg-gray-100 text-gray-800'
                                        : 'text-gray-400'
                                    } ${!isSelectable && isSameMonth ? 'opacity-30 cursor-not-allowed' : ''} ${isToday ? 'font-bold' : ''}`}
                                  >
                                    {date.getDate()}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                  
                  {/* 选中周提示 */}
                  {selectedBMIWeek && (
                    <div className="mt-3 p-2 bg-blue-50 rounded-lg text-center text-sm text-blue-700">
                      已选择：第{selectedBMIWeek}周
                    </div>
                  )}
                </div>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  选择Excel文件
                </label>
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={(e) => {
                    if (e.target.files && e.target.files[0]) {
                      setBmiUploadFile(e.target.files[0]);
                    }
                  }}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                {bmiUploadFile && (
                  <p className="mt-2 text-sm text-gray-600">
                    已选择: {bmiUploadFile.name}
                  </p>
                )}
              </div>
              
              <div className="bg-blue-50 p-4 rounded-lg">
                <h4 className="text-sm font-medium text-blue-800 mb-2">表格格式说明</h4>
                <p className="text-xs text-blue-700">
                  Excel表格需包含以下列：<br/>
                  • 姓名（必填）<br/>
                  • 体重 或 体重(kg) 或 体重kg（必填）<br/>
                  注：身高已固定，无需填写
                </p>
              </div>
            </div>
            <div className="flex gap-3 p-6 border-t border-gray-200">
              <button
                onClick={() => {
                  setShowBMIUploadModal(false);
                  setBmiUploadFile(null);
                }}
                className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
              >
                取消
              </button>
              <button
                onClick={async () => {
                  if (!selectedBMIWeek) {
                    showNotification('请选择周数', 'error');
                    return;
                  }
                  if (!bmiUploadFile) {
                    showNotification('请选择文件', 'error');
                    return;
                  }
                  
                  try {
                    setBmiUploading(true);
                    const formData = new FormData();
                    formData.append('file', bmiUploadFile);
                    formData.append('week', selectedBMIWeek);
                    if (selectedSemesterId) {
                      formData.append('semesterId', selectedSemesterId);
                    }
                    
                    const res = await axios.post(getFullApiUrl('/api/upload/bmi-scores'), formData, {
                      headers: {
                        'Content-Type': 'multipart/form-data'
                      }
                    });
                    
                    if (res.data.success) {
                      showNotification(`${res.data.message}，共导入${res.data.count}条数据`, 'success');
                      // 刷新BMI数据
                      fetchBMIByWeek(selectedBMIWeek).then(data => {
                        setBmiData(data || {});
                      });
                      setShowBMIUploadModal(false);
                      setBmiUploadFile(null);
                    }
                  } catch (err) {
                    console.error('Failed to upload BMI data', err);
                    showNotification(err.response?.data?.error || '上传失败', 'error');
                  } finally {
                    setBmiUploading(false);
                  }
                }}
                disabled={!selectedBMIWeek || !bmiUploadFile || bmiUploading}
                className="flex-1 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {bmiUploading ? (
                  <>
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    上传中...
                  </>
                ) : (
                  '上传'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 所有BMI录入数据折线图 Modal */}
      {showAllBMIModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 className="text-xl font-bold text-gray-900">BMI 变化趋势（录入数据）</h2>
              <button
                onClick={() => setShowAllBMIModal(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            <div className="p-6 overflow-y-auto flex-1">
              {(() => {
                const memberId = selectedMemberDetail?.member?.id;
                if (!memberId) {
                  return <div className="text-center py-8 text-gray-500">无法获取成员信息</div>;
                }
                
                // 使用宽松相等来匹配可能不同的ID类型（字符串或数字）
                const memberBMIData = allBMIData.filter(d => d.memberId == memberId || String(d.memberId) === String(memberId));
                
                if (memberBMIData.length === 0) {
                  return (
                    <div className="text-center py-8 text-gray-500">
                      暂无BMI录入数据
                      <p className="text-sm mt-2">请通过"BMI数据录入"功能录入体重数据</p>
                    </div>
                  );
                }
                
                // 判断成员性别
                const isFemale = isFemaleMember(selectedMemberDetail?.member?.id);
                
                // 获取ECharts配置
                const chartOption = getBMILineChartOption(memberBMIData, isFemale);
                
                return (
                  <div>
                    {/* ECharts折线图 */}
                    {chartOption && (
                      <ReactECharts
                        option={chartOption}
                        style={{ height: '400px', width: '100%' }}
                      />
                    )}
                  </div>
                );
              })()}
            </div>
            <div className="p-6 border-t border-gray-200">
              <button
                onClick={() => setShowAllBMIModal(false)}
                className="w-full px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* BMI数据展示 Modal */}
      {showBMIDisplayModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 className="text-xl font-bold text-gray-900">BMI数据一览</h2>
              <div className="flex items-center gap-3">
                <button
                  onClick={exportBMIToExcel}
                  className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0L8 8m4 4v12" />
                  </svg>
                  下载Excel
                </button>
                <button
                  onClick={() => setShowBMIDisplayModal(false)}
                  className="text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <X size={24} />
                </button>
              </div>
            </div>
            <div className="p-6 overflow-y-auto flex-1">
              {bmiDisplayData.weeks.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  暂无BMI数据
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="bg-gray-100">
                        <th className="border border-gray-300 px-4 py-3 text-left font-bold">姓名</th>
                        <th className="border border-gray-300 px-4 py-3 text-left font-bold">班级</th>
                        {bmiDisplayData.weeks.map(w => (
                          <th key={w.week} className="border border-gray-300 px-4 py-3 text-center font-bold" colSpan={1}>
                            第{w.week}周<br/>
                            <span className="text-xs font-normal text-gray-500">
                              {w.startDate}~{w.endDate}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {bmiDisplayData.members.map(member => {
                        const isFemale = isFemaleMember(member.id);
                        return (
                          <tr key={member.id} className="hover:bg-gray-50">
                            <td className="border border-gray-300 px-4 py-2 font-medium">{member.name}</td>
                            <td className="border border-gray-300 px-4 py-2">{member.class}</td>
                            {bmiDisplayData.weeks.map(w => {
                              const bmi = member.bmi[w.week];
                              // BMI及格标准：18.5-23.9（女）或 18.5-25.9（男）
                              const isPass = bmi !== undefined && bmi >= 18.5 && bmi <= (isFemale ? 23.9 : 25.9);
                              return (
                                <td
                                  key={w.week}
                                  className={`border border-gray-300 px-4 py-2 text-center ${
                                    bmi !== undefined && !isPass ? 'bg-red-100 text-red-700 font-bold' : ''
                                  }`}
                                >
                                  {bmi !== undefined ? bmi : '-'}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-xl">
                <h3 className="text-sm font-bold text-yellow-700 mb-2">BMI及格标准</h3>
                <p className="text-xs text-gray-600">
                  男生：18.5 ~ 25.9 | 女生：18.5 ~ 23.9<br/>
                  红色单元格表示不及格的BMI数据
                </p>
              </div>
            </div>
            <div className="p-6 border-t border-gray-200">
              <button
                onClick={() => setShowBMIDisplayModal(false)}
                className="w-full px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 修改评分 Modal */}
      {showEditScoreModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 className="text-xl font-bold text-gray-900">修改评分数据</h2>
              <button
                onClick={() => setShowEditScoreModal(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            <div className="p-6 space-y-4 overflow-y-auto flex-1">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  选择周数
                </label>
                <select
                  value={editScoreWeek || ''}
                  onChange={(e) => setEditScoreWeek(parseInt(e.target.value))}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">请选择周数</option>
                  {Array.from({ length: config.currentWeek }, (_, i) => i + 1).map(week => (
                    <option key={week} value={week}>第{week}周</option>
                  ))}
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  被评分者班级
                </label>
                <select
                  value={editScoreMember?.class || ''}
                  onChange={(e) => {
                    const className = e.target.value;
                    const firstMember = members.find(m => m.class === className);
                    if (firstMember) {
                      setEditScoreMember(firstMember);
                      setEditScoreEvaluator(null);
                    }
                  }}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">请选择班级</option>
                  {classes.map(c => (
                    <option key={c} value={c}>{maskClassName(c)}</option>
                  ))}
                </select>
              </div>
              
              {editScoreMember && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    选择被评分者
                  </label>
                  <select
                    value={editScoreMember?.id || ''}
                    onChange={(e) => {
                      const member = members.find(m => m.id === e.target.value);
                      if (member) {
                        setEditScoreMember(member);
                        setEditScoreEvaluator(null);
                      }
                    }}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">请选择被评分者</option>
                    {members.filter(m => m.class === editScoreMember.class).map(member => (
                      <option key={member.id} value={member.id}>{maskName(member.name)}</option>
                    ))}
                  </select>
                </div>
              )}
              
              {editScoreMember && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    选择评分者
                  </label>
                  <select
                    value={editScoreEvaluator?.id || ''}
                    onChange={(e) => {
                      const evaluator = members.find(m => m.id === e.target.value);
                      if (evaluator) {
                        setEditScoreEvaluator(evaluator);
                        fetchAndLoadMemberScore(editScoreMember.id, evaluator.id);
                      }
                    }}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">请选择评分者</option>
                    {members.filter(m => m.class === editScoreMember.class).map(member => (
                      <option key={member.id} value={member.id}>{maskName(member.name)}</option>
                    ))}
                  </select>
                </div>
              )}
              
              {targetMember && editScoreMember && (
                <div className="mt-4">
                  <div className="bg-blue-50 p-4 rounded-lg mb-4">
                    <p className="text-sm text-gray-700">
                      当前查看：<span className="font-bold">{maskName(targetMember.name)}</span> 
                      {targetMember.id === editScoreMember.id && ' (选择修改)'}
                    </p>
                  </div>
                  
                  {dimensions.map(dim => {
                    const dimensionScore = getDimensionScores()[dim.key];
                    return (
                      <div key={dim.key} className="mb-6 border border-gray-200 rounded-lg p-4">
                        <div className="flex justify-between items-center mb-4">
                          <label className="font-bold text-gray-800 text-lg">{dim.label}</label>
                          <span className="text-blue-600 font-bold text-xl">{dimensionScore}分</span>
                        </div>
                        
                        {dim.subItems.map(subItem => {
                          const scoreKey = `${dim.key}_${subItem.key}`;
                          return (
                            <div key={subItem.key} className="space-y-2 mb-4">
                              <div className="flex justify-between items-center">
                                <span className="font-medium text-gray-700">{subItem.label}</span>
                                <span className="text-blue-600 font-bold">{subItemScores[scoreKey] || subItem.minScore}分 / {subItem.maxScore}分</span>
                              </div>
                              <input
                                type="range"
                                min={subItem.minScore}
                                max={subItem.maxScore}
                                step={0.5}
                                value={subItemScores[scoreKey] || subItem.minScore}
                                onChange={(e) => setSubItemScores({ ...subItemScores, [scoreKey]: parseFloat(e.target.value) })}
                                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                              />
                              <div className="text-xs text-gray-500 bg-white p-3 rounded-lg border border-gray-100">
                                {subItem.criteria}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="flex gap-3 p-6 border-t border-gray-200">
              <button
                onClick={() => setShowEditScoreModal(false)}
                className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
              >
                取消
              </button>
              <button
                onClick={async () => {
                  if (!editScoreWeek || !editScoreMember || !editScoreEvaluator) {
                    return;
                  }
                  
                  if (confirm(`确定要删除${maskName(editScoreEvaluator.name)}对${maskName(editScoreMember.name)}在第${editScoreWeek}周的评分吗？`)) {
                    try {
                      setEditScoreSaving(true);
                      const res = await axios.post(getFullApiUrl('/api/scores/delete'), {
                        week: editScoreWeek,
                        semesterId: selectedSemesterId || config.currentSemesterId,
                        memberId: editScoreMember.id,
                        evaluatorId: editScoreEvaluator.id
                      });
                      if (res.data.success) {
                        showNotification('已删除评分', 'success');
                        // 重置当前编辑的数据
                        const defaultScores = {};
                        dimensions.forEach(dim => {
                          dim.subItems.forEach(subItem => {
                            defaultScores[`${dim.key}_${subItem.key}`] = subItem.minScore;
                          });
                        });
                        setSubItemScores(defaultScores);
                        setEditScoreData(null);
                      }
                    } catch (err) {
                      console.error('Failed to delete score', err);
                      showNotification(err.response?.data?.error || '删除失败', 'error');
                    } finally {
                      setEditScoreSaving(false);
                    }
                  }
                }}
                disabled={!editScoreWeek || !editScoreMember || !editScoreEvaluator || editScoreSaving}
                className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                重置
              </button>
              <button
                onClick={async () => {
                  if (!editScoreWeek || !editScoreEvaluator) {
                    return;
                  }
                  
                  if (confirm(`确定要清除${maskName(editScoreEvaluator.name)}在第${editScoreWeek}周的所有评分吗？此操作不可恢复！`)) {
                    try {
                      setEditScoreSaving(true);
                      const res = await axios.post(getFullApiUrl('/api/scores/delete-all-evaluator'), {
                        week: editScoreWeek,
                        semesterId: selectedSemesterId || config.currentSemesterId,
                        evaluatorId: editScoreEvaluator.id
                      });
                      if (res.data.success) {
                        showNotification('已清除所有评分', 'success');
                        // 重置当前编辑的数据
                        const defaultScores = {};
                        dimensions.forEach(dim => {
                          dim.subItems.forEach(subItem => {
                            defaultScores[`${dim.key}_${subItem.key}`] = subItem.minScore;
                          });
                        });
                        setSubItemScores(defaultScores);
                        setEditScoreData(null);
                      }
                    } catch (err) {
                      console.error('Failed to delete all scores', err);
                      showNotification(err.response?.data?.error || '清除失败', 'error');
                    } finally {
                      setEditScoreSaving(false);
                    }
                  }
                }}
                disabled={!editScoreWeek || !editScoreEvaluator || editScoreSaving}
                className="px-4 py-2 bg-red-700 text-white rounded-lg hover:bg-red-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                全部重置
              </button>
              <button
                onClick={async () => {
                  try {
                    setEditScoreSaving(true);
                    const res = await axios.post(getFullApiUrl('/api/scores/update'), {
                      week: editScoreWeek,
                      semesterId: selectedSemesterId || config.currentSemesterId,
                      memberId: editScoreMember.id,
                      evaluatorId: editScoreEvaluator.id,
                      scores: getDimensionScores(),
                      subItemScores
                    });
                    if (res.data.success) {
                      showNotification('评分更新成功', 'success');
                      setShowEditScoreModal(false);
                    }
                  } catch (err) {
                    console.error('Failed to update score', err);
                    showNotification(err.response?.data?.error || '评分更新失败', 'error');
                  } finally {
                    setEditScoreSaving(false);
                  }
                }}
                disabled={!editScoreWeek || !editScoreMember || !editScoreEvaluator || editScoreSaving}
                className="flex-1 px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {editScoreSaving ? (
                  <>
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    保存中...
                  </>
                ) : (
                  '保存修改'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 修改BMI数据 Modal */}
      {showEditBMIModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 className="text-xl font-bold text-gray-900">修改BMI数据</h2>
              <button
                onClick={() => setShowEditBMIModal(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            <div className="p-6 space-y-4 overflow-y-auto flex-1">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  选择周数
                </label>
                <select
                  value={editBMIWeek || ''}
                  onChange={(e) => {
                    const week = parseInt(e.target.value);
                    setEditBMIWeek(week);
                    fetchBMIByWeek(week).then(data => {
                      setEditBMIAllData(data || {});
                    });
                  }}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">请选择周数</option>
                  <option value={config.currentWeek}>第{config.currentWeek}周（当前周）</option>
                </select>
              </div>
              
              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-gray-900">班级成员</h3>
                {classes.map(className => {
                  const classMembers = members.filter(m => m.class === className);
                  return (
                    <div key={className} className="border border-gray-200 rounded-lg">
                      <button
                        onClick={() => setExpandedBMIClass(expandedBMIClass === className ? null : className)}
                        className="w-full px-4 py-3 bg-gray-50 flex items-center justify-between hover:bg-gray-100 transition-colors rounded-t-lg"
                      >
                        <span className="font-semibold text-gray-800">{className}</span>
                        <svg
                          className={`w-5 h-5 text-gray-500 transition-transform ${expandedBMIClass === className ? 'rotate-90' : ''}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                      {expandedBMIClass === className && (
                        <div className="p-4 space-y-3">
                          {classMembers.map(member => {
                            const memberBMI = editBMIAllData[member.id] || {};
                            const fixedHeight = fixedHeights[member.id];
                            const bmi = calculateBMI(fixedHeight, memberBMI.weight);
                            return (
                              <div key={member.id} className="grid grid-cols-1 md:grid-cols-3 gap-3 items-center bg-gray-50 p-3 rounded-lg">
                                <div className="md:col-span-1">
                                  <span className="font-medium text-gray-800">{member.name}</span>
                                </div>
                                <div>
                                  <label className="block text-xs text-gray-500 mb-1">身高(cm) <span className="text-blue-600">(固定)</span></label>
                                  <div className="px-3 py-2 bg-gray-100 border border-gray-200 rounded-lg text-sm">
                                    {fixedHeight || '-'}
                                  </div>
                                </div>
                                <div>
                                  <label className="block text-xs text-gray-500 mb-1">体重(kg)</label>
                                  <input
                                    type="number"
                                    step="0.1"
                                    value={memberBMI.weight || ''}
                                    onChange={(e) => {
                                      const newData = { ...editBMIAllData };
                                      if (!newData[member.id]) newData[member.id] = {};
                                      newData[member.id].weight = e.target.value;
                                      setEditBMIAllData(newData);
                                    }}
                                    placeholder="70.5"
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs text-gray-500 mb-1">BMI</label>
                                  <div className={`px-3 py-2 border rounded-lg text-sm font-medium ${
                                    bmi ? (
                                      parseFloat(bmi) >= 18.5 && parseFloat(bmi) <= 23.9
                                        ? 'bg-green-50 border-green-300 text-green-800'
                                        : 'bg-yellow-50 border-yellow-300 text-yellow-800'
                                    ) : 'bg-gray-50 border-gray-300 text-gray-400'
                                  }`}>
                                    {bmi || '-'}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="flex gap-3 p-6 border-t border-gray-200">
              <button
                onClick={() => setShowEditBMIModal(false)}
                className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
              >
                取消
              </button>
              <button
                onClick={async () => {
                  try {
                    setEditBMISaving(true);
                    const res = await axios.post(getFullApiUrl('/api/bmi/save-admin'), {
                      week: editBMIWeek,
                      semesterId: selectedSemesterId || undefined,
                      data: editBMIAllData
                    });
                    if (res.data.success) {
                      showNotification('BMI数据更新成功', 'success');
                      setShowEditBMIModal(false);
                    }
                  } catch (err) {
                    console.error('Failed to update BMI data', err);
                    showNotification(err.response?.data?.error || 'BMI数据更新失败', 'error');
                  } finally {
                    setEditBMISaving(false);
                  }
                }}
                disabled={!editBMIWeek || editBMISaving}
                className="flex-1 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {editBMISaving ? (
                  <>
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    保存中...
                  </>
                ) : (
                  '保存修改'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 设置版本号 Modal */}
      {showSetVersionModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 className="text-xl font-bold text-gray-900">设置版本号</h2>
              <button
                onClick={() => setShowSetVersionModal(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  版本号 (如: 1.0.0)
                </label>
                <input
                  type="text"
                  value={apkVersion}
                  onChange={(e) => setApkVersion(e.target.value)}
                  placeholder="1.0.0"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  版本号代码 (数字, 如: 1)
                </label>
                <input
                  type="number"
                  min="1"
                  value={apkVersionCode}
                  onChange={(e) => setApkVersionCode(e.target.value)}
                  placeholder="1"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <p className="text-xs text-gray-500 mt-2">
                * 仅修改本地 build.gradle 文件，不修改服务器版本信息请使用"应用更新"功能
              </p>
              <div className="flex gap-3 pt-4">
                <button
                  onClick={() => setShowSetVersionModal(false)}
                  className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleSetVersion}
                  disabled={!apkVersion || !apkVersionCode || settingVersion}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {settingVersion ? (
                    <>
                      <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                      设置中...
                    </>
                  ) : (
                    '设置'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Update Modal */}
      {showUpdateModal && updateInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-70">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
            <div className="p-6">
              <div className="text-center mb-6">
                <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <svg className="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </div>
                <h2 className="text-xl font-bold text-gray-900 mb-2">发现新版本</h2>
                <p className="text-gray-600">
                  版本 {updateInfo.version} (版本代码: {updateInfo.versionCode})
                </p>
              </div>
              
              {updateInfo.releaseNotes && (
                <div className="mb-6">
                  <h3 className="text-sm font-semibold text-gray-700 mb-2">更新内容:</h3>
                  <div className="bg-gray-50 rounded-lg p-4">
                    <p className="text-sm text-gray-600 whitespace-pre-wrap">{updateInfo.releaseNotes}</p>
                  </div>
                </div>
              )}

              {updateInfo.updateRequired && (
                <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
                  <p className="text-red-700 text-sm font-medium">
                    ⚠️ 本次更新为强制更新，必须更新后才能继续使用
                  </p>
                </div>
              )}

              <div className="space-y-3">
                <button
                  onClick={downloadAndInstallUpdate}
                  disabled={downloadingUpdate}
                  className="w-full px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {downloadingUpdate ? (
                    <>
                      <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                      下载中...
                    </>
                  ) : (
                    '下载并安装'
                  )}
                </button>
                
                {!updateInfo.updateRequired && (
                  <button
                    onClick={handleRemindLater}
                    className="w-full px-4 py-3 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                  >
                    稍后再说
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 心理数据修改弹窗 */}
      {showPsychologyEditModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200 bg-gradient-to-r from-pink-500 to-pink-600">
              <h2 className="text-xl font-bold text-white">修改心理数据</h2>
              <button
                onClick={() => setShowPsychologyEditModal(false)}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* 成员选择 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">选择成员</label>
                <select
                  value={psychologyEditMember?.id || ''}
                  onChange={(e) => {
                    const member = members.find(m => m.id === e.target.value);
                    setPsychologyEditMember(member || null);
                    if (member) {
                      // 加载该成员的心理数据
                      const nomData = nominations.find(n => n.evaluatorId === member.id);
                      if (nomData) {
                        setPsychologyEditData({
                          positiveNominations: nomData.positiveNominations || [],
                          negativeNominations: nomData.negativeNominations || [],
                          moodTag: nomData.moodTag || null,
                          selfAssessment: nomData.selfAssessment || null
                        });
                      } else {
                        setPsychologyEditData({
                          positiveNominations: [],
                          negativeNominations: [],
                          moodTag: null,
                          selfAssessment: null
                        });
                      }
                    }
                  }}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-pink-500"
                >
                  <option value="">-- 请选择成员 --</option>
                  {members.map(m => (
                    <option key={m.id} value={m.id}>{m.name} ({m.class})</option>
                  ))}
                </select>
              </div>

              {/* 更新类型选择 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">修改类型</label>
                <div className="flex flex-wrap gap-2">
                  {['all', 'nominations', 'mood', 'selfAssessment'].map(type => (
                    <button
                      key={type}
                      onClick={() => setPsychologyEditType(type)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                        psychologyEditType === type 
                          ? 'bg-pink-600 text-white' 
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                      }`}
                    >
                      {type === 'all' ? '全部' : type === 'nominations' ? '提名' : type === 'mood' ? '标签' : '自评'}
                    </button>
                  ))}
                </div>
              </div>

              {/* 提名修改 */}
              {(psychologyEditType === 'nominations' || psychologyEditType === 'all') && psychologyEditMember && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">正向提名</label>
                  <select
                    value={psychologyEditPositiveClass || ''}
                    onChange={(e) => setPsychologyEditPositiveClass(e.target.value || null)}
                    className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-green-500"
                  >
                    <option value="">-- 选择班级 --</option>
                    {classes.map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {members.filter(m => {
                      if (m.id === psychologyEditMember.id) return false;
                      if (!psychologyEditPositiveClass) return true;
                      return m.class === psychologyEditPositiveClass;
                    }).map(m => (
                      <button
                        key={m.id}
                        onClick={() => {
                          const current = psychologyEditData.positiveNominations || [];
                          if (current.includes(m.id)) {
                            setPsychologyEditData({
                              ...psychologyEditData,
                              positiveNominations: current.filter(id => id !== m.id)
                            });
                          } else {
                            setPsychologyEditData({
                              ...psychologyEditData,
                              positiveNominations: [...current, m.id]
                            });
                          }
                        }}
                        className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                          (psychologyEditData.positiveNominations || []).includes(m.id)
                            ? 'bg-green-500 text-white'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        }`}
                      >
                        {m.name} <span className="text-xs opacity-70">({m.class})</span>
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-gray-500">已选择：{(psychologyEditData.positiveNominations || []).length}人</p>
                </div>
              )}

              {(psychologyEditType === 'nominations' || psychologyEditType === 'all') && psychologyEditMember && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">负向提名</label>
                  <select
                    value={psychologyEditNegativeClass || ''}
                    onChange={(e) => setPsychologyEditNegativeClass(e.target.value || null)}
                    className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-red-500"
                  >
                    <option value="">-- 选择班级 --</option>
                    {classes.map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {members.filter(m => {
                      if (m.id === psychologyEditMember.id) return false;
                      if (!psychologyEditNegativeClass) return true;
                      return m.class === psychologyEditNegativeClass;
                    }).map(m => (
                      <button
                        key={m.id}
                        onClick={() => {
                          const current = psychologyEditData.negativeNominations || [];
                          if (current.includes(m.id)) {
                            setPsychologyEditData({
                              ...psychologyEditData,
                              negativeNominations: current.filter(id => id !== m.id)
                            });
                          } else {
                            setPsychologyEditData({
                              ...psychologyEditData,
                              negativeNominations: [...current, m.id]
                            });
                          }
                        }}
                        className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                          (psychologyEditData.negativeNominations || []).includes(m.id)
                            ? 'bg-red-500 text-white'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        }`}
                      >
                        {m.name} <span className="text-xs opacity-70">({m.class})</span>
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-gray-500">已选择：{(psychologyEditData.negativeNominations || []).length}人</p>
                </div>
              )}

              {/* 标签修改 */}
              {(psychologyEditType === 'mood' || psychologyEditType === 'all') && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">心情标签</label>
                  <div className="flex flex-wrap gap-2">
                    {['开心', '满足', '平静', '焦虑', '沮丧', '愤怒', '疲惫', '孤独', '兴奋', '自信', '紧张', '放松', '快乐', '悲伤', '烦躁', '温暖'].map(tag => (
                      <button
                        key={tag}
                        onClick={() => setPsychologyEditData({...psychologyEditData, moodTag: tag})}
                        className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                          psychologyEditData.moodTag === tag
                            ? 'bg-purple-600 text-white'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        }`}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 自评修改 */}
              {(psychologyEditType === 'selfAssessment' || psychologyEditType === 'all') && (
                <div className="space-y-4">
                  <label className="block text-sm font-medium text-gray-700">心理自评</label>
                  {[
                    { key: 'sleepQuality', label: '睡眠质量' },
                    { key: 'emotionalState', label: '情绪状态' },
                    { key: 'stressLevel', label: '压力感受' },
                    { key: 'appetite', label: '食欲状况' }
                  ].map(item => (
                    <div key={item.key}>
                      <label className="block text-xs text-gray-600 mb-1">{item.label} (1-10)</label>
                      <input
                        type="range"
                        min="1"
                        max="10"
                        value={psychologyEditData.selfAssessment?.[item.key] || 5}
                        onChange={(e) => setPsychologyEditData({
                          ...psychologyEditData,
                          selfAssessment: {
                            ...(psychologyEditData.selfAssessment || {}),
                            [item.key]: parseInt(e.target.value)
                          }
                        })}
                        className="w-full"
                      />
                      <div className="flex justify-between text-xs text-gray-400">
                        <span>1</span>
                        <span className="font-medium text-pink-600">{psychologyEditData.selfAssessment?.[item.key] || 5}</span>
                        <span>10</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="p-6 border-t border-gray-200 bg-gray-50">
              <button
                onClick={async () => {
                  if (!psychologyEditMember) {
                    showNotification('请先选择成员', 'warning');
                    return;
                  }

                  try {
                    const res = await fetch(getFullApiUrl('/api/admin/psychological-data/update'), {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        evaluatorId: psychologyEditMember.id,
                        positiveNominations: psychologyEditData.positiveNominations,
                        negativeNominations: psychologyEditData.negativeNominations,
                        moodTag: psychologyEditData.moodTag,
                        selfAssessment: psychologyEditData.selfAssessment,
                        updateType: psychologyEditType
                      })
                    });

                    if (!res.ok) throw new Error('更新失败');

                    showNotification('心理数据更新成功', 'success');
                    setShowPsychologyEditModal(false);
                    
                    // 刷新数据
                    await fetchNominations();
                    await fetchMemberStates();
                  } catch (err) {
                    console.error('Update psychology data error:', err);
                    showNotification('更新失败：' + err.message, 'error');
                  }
                }}
                className="w-full px-6 py-3 bg-pink-600 text-white rounded-lg hover:bg-pink-700 transition-colors font-medium"
              >
                保存修改
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 学习成绩弹窗 */}
      {showAcademicModal && selectedMemberDetail && academicScoresDisplay && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200 bg-gradient-to-r from-blue-500 to-blue-600">
              <h2 className="text-xl font-bold text-white">学习成绩</h2>
              <button
                onClick={() => setShowAcademicModal(false)}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {/* 竞赛经历 */}
              <div className="mb-6">
                <h3 className="text-lg font-bold text-blue-700 mb-3 flex items-center gap-2">
                  <span>🏆</span> 竞赛经历
                </h3>
                {(() => {
                  const competitionExperiences = experiences.filter(e => e.type === 'competition');
                  if (competitionExperiences.length === 0) {
                    return <p className="text-gray-500 text-sm">暂无竞赛经历</p>;
                  }
                  const levelLabels = {
                    college: '院级',
                    school: '校级',
                    city: '市级',
                    province: '省级',
                    national: '全国',
                    international: '国际'
                  };
                  return (
                    <div className="space-y-2">
                      {competitionExperiences
                        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                        .map(exp => (
                          <div key={exp.id} className="p-3 bg-blue-50 rounded-lg border-l-4 border-blue-500">
                            <div className="flex items-center gap-2">
                              <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs font-medium rounded">
                                {levelLabels[exp.data.level]}
                              </span>
                              <p className="font-medium text-gray-900">{exp.data.name}</p>
                            </div>
                            {exp.data.award && (
                              <p className="text-sm text-blue-600 mt-1">🏅 {exp.data.award}</p>
                            )}
                            <p className="text-xs text-gray-400 mt-1">
                              {new Date(exp.createdAt).toLocaleDateString('zh-CN')}
                            </p>
                          </div>
                        ))}
                    </div>
                  );
                })()}
              </div>

              {/* 科研经历 */}
              <div className="mb-6">
                <h3 className="text-lg font-bold text-blue-700 mb-3 flex items-center gap-2">
                  <span>🔬</span> 科研经历
                </h3>
                {(() => {
                  const researchExperiences = experiences.filter(e => e.type === 'research');
                  if (researchExperiences.length === 0) {
                    return <p className="text-gray-500 text-sm">暂无科研经历</p>;
                  }
                  return (
                    <div className="space-y-2">
                      {researchExperiences
                        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                        .map(exp => (
                          <div key={exp.id} className="p-3 bg-blue-50 rounded-lg border-l-4 border-blue-500">
                            <p className="font-medium text-gray-900">{exp.data.name}</p>
                            <p className="text-sm text-blue-600 mt-1">
                              {exp.data.hasAdvisor ? '✅ 已签约导师' : '⏳ 未签约导师'}
                            </p>
                            <p className="text-xs text-gray-400 mt-1">
                              {new Date(exp.createdAt).toLocaleDateString('zh-CN')}
                            </p>
                          </div>
                        ))}
                    </div>
                  );
                })()}
              </div>

              <div className="overflow-x-auto mb-6">
                <table className="w-full border-collapse border border-gray-200 rounded-xl overflow-hidden">
                  <thead className="bg-blue-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-gray-600 border-b">科目</th>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-gray-600 border-b">成绩</th>
                    </tr>
                  </thead>
                  <tbody>
                    {academicScoresDisplay.filteredScores.map(entry => (
                      <tr key={entry[0]} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm text-gray-700 border-b">{entry[0]}</td>
                        <td className="px-4 py-3 text-sm font-bold border-b">
                          {typeof entry[1] === 'number' && !isNaN(entry[1]) ? (
                            <span className={entry[1] < 60 ? 'text-red-600' : 'text-blue-600'}>{entry[1]}</span>
                          ) : typeof entry[1] === 'string' && entry[1].trim() !== '' ? (
                            <span className="text-blue-600">{entry[1]}</span>
                          ) : (
                            <span className="text-gray-400 italic">未参考</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-blue-50 font-bold">
                      <td className="px-4 py-3 text-sm text-blue-700 border-b">平均分</td>
                      <td className="px-4 py-3 text-sm font-bold text-blue-700 border-b">
                        {academicScoresDisplay.averageScore}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              
              {/* 二级评分 */}
              {lastWeekSubScores && lastWeekSubScores.subItemScores && (
                <div className="mb-4 p-4 bg-blue-50 border border-blue-100 rounded-xl">
                  <h3 className="text-lg font-bold text-blue-700 mb-3">
                    第{lastWeekSubScores.week}周学习成绩二级评分
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {dimensions.find(d => d.key === 'study')?.subItems.map(subItem => {
                      const scoreKey = `study_${subItem.key}`;
                      const score = lastWeekSubScores.subItemScores[scoreKey];
                      return (
                        <div key={subItem.key} className="flex justify-between items-center p-3 bg-white rounded-lg">
                          <span className="text-sm text-gray-700">{subItem.label}</span>
                          <span className="font-bold text-blue-600">
                            {score !== undefined && score !== null ? score.toFixed(1) : '-'}
                            <span className="text-xs text-gray-400 ml-1">/{subItem.maxScore}</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              
              {academicScoresDisplay.failCount > 0 && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                  <p className="text-red-700 font-medium">挂科 {academicScoresDisplay.failCount} 科</p>
                </div>
              )}
              
              {/* 学期排名 */}
              {selectedMemberRank && memberRankData && memberRankData.validSemesterScores.length > 0 && (
                <div className="mb-4 p-4 bg-orange-50 border border-orange-100 rounded-xl">
                  <h3 className="text-lg font-bold text-orange-700 mb-3">学期排名</h3>
                  <div className="space-y-2">
                    {memberRankData.sortedSemesterScores.map((sem, idx) => (
                      <div key={idx} className="flex justify-between items-center">
                        <span className="text-sm text-gray-700">{sem.semester}</span>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-orange-600">第 {sem.rank} 名</span>
                          {sem.score !== undefined && (
                            <span className="text-sm text-gray-500">({sem.score}分)</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  {semesterRankChangeDisplay && (
                    <div className="mt-3 pt-3 border-t border-orange-200">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-gray-600">较上一学期排名变化：</span>
                        <span className={`font-bold ${semesterRankChangeDisplay.colorClass}`}>
                          {semesterRankChangeDisplay.text}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}
              
              {/* 总成绩排名 */}
              {selectedMemberRank && memberRankData && memberRankData.showTotalRankSection && (
                <div className="mb-4 p-4 bg-purple-50 border border-purple-100 rounded-xl">
                  <h3 className="text-lg font-bold text-purple-700 mb-3">总成绩排名</h3>
                  <div className="space-y-2">
                    {memberRankData.currentTotalRank && (
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-gray-700">当前总成绩排名</span>
                        <span className="font-bold text-purple-600">第 {memberRankData.currentTotalRank.rank} 名</span>
                      </div>
                    )}
                    {memberRankData.yearRanks.slice().reverse().map((yr, idx) => (
                      <div key={idx} className="flex justify-between items-center">
                        <span className="text-sm text-gray-700">{yr.name}</span>
                        <span className="font-bold text-purple-600">
                          {typeof yr.rank === 'number' ? `第 ${yr.rank} 名` : yr.rank}
                        </span>
                      </div>
                    ))}
                    {memberRankData.totalRankChange && (
                      <div className="mt-3 pt-3 border-t border-purple-200">
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-gray-600">{memberRankData.totalRankChange.name}：</span>
                          <span className="font-bold text-purple-600">{memberRankData.totalRankChange.rank}</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {selectedMemberRank && selectedMemberRank.semesterScores && selectedMemberRank.semesterScores.length > 0 && (
                  <div>
                    <h4 className="text-md font-bold text-gray-800 mb-3">成绩变化趋势</h4>
                    <div style={{ height: '250px' }}>
                      <ReactECharts option={getScoreLineChartOption(selectedMemberRank.semesterScores)} style={{ height: '100%', width: '100%' }} />
                    </div>
                  </div>
                )}
                
                {selectedMemberRank && selectedMemberRank.semesterScores && selectedMemberRank.semesterScores.length > 0 && (
                  <div>
                    <h4 className="text-md font-bold text-gray-800 mb-3">排名变化趋势</h4>
                    <div style={{ height: '250px' }}>
                      <ReactECharts option={getRankLineChartOption(selectedMemberRank.semesterScores)} style={{ height: '100%', width: '100%' }} />
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="p-4 border-t border-gray-200">
              <button
                onClick={() => setShowAcademicModal(false)}
                className="w-full px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 体能素质弹窗 */}
      {showFitnessModal && selectedMemberDetail && selectedMemberDetail.fitnessScores && selectedMemberDetail.fitnessScores.length > 0 && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200 bg-gradient-to-r from-green-500 to-green-600">
              <h2 className="text-xl font-bold text-white">体能素质</h2>
              <button
                onClick={() => setShowFitnessModal(false)}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {(() => {
                const fitnessData = selectedMemberDetail.fitnessScores[0];
                let history = fitnessData.history || [];
                let latestScores = {};
                
                if (history.length === 0 && fitnessData.scores) {
                  latestScores = fitnessData.scores;
                } else if (history.length > 0) {
                  const latestHistory = [...history].sort((a, b) => b.month.localeCompare(a.month))[0];
                  latestScores = latestHistory.scores;
                }
                
                const isFemale = isFemaleMember(selectedMemberDetail.member.id);
                
                const itemsToShow = new Set(Object.keys(latestScores));
                
                const tableRows = Array.from(itemsToShow)
                  .filter(item => {
                    if (item === '备注' || item === '身高' || item === '体重' || item === 'BMI') {
                      const score = latestScores[item];
                      if (score === null || score === undefined || (typeof score === 'string' && score.trim() === '')) {
                        return false;
                      }
                      if (item === '身高' || item === '体重' || item === 'BMI') {
                        return false;
                      }
                    }
                    return true;
                  })
                  .map(item => {
                    let score = latestScores[item];
                    
                    let displayScore = score;
                    let displayIsPass = isFitnessScorePass(item, score, isFemale);
                    
                    let displayItem = item;
                    if (item === '屈臂悬垂' || item === '曲臂悬垂' || item === '单杠' || item === '屈臂悬垂/单杠' || item === '曲臂悬垂/单杠') {
                      displayItem = isFemale ? '曲臂悬垂' : '单杠';
                    }
                    
                    const isExpanded = expandedFitnessItem === item;
                    
                    return (
                      <React.Fragment key={item}>
                        <tr 
                          className="hover:bg-gray-50 cursor-pointer"
                          onClick={() => setExpandedFitnessItem(isExpanded ? null : item)}
                        >
                          <td className="px-4 py-3 text-sm text-gray-700 border-b flex items-center gap-2">
                            <span>{isExpanded ? '▼' : '▶'}</span>
                            {displayItem}
                          </td>
                          <td className="px-4 py-3 text-sm font-bold border-b">
                            {typeof displayScore === 'number' && !isNaN(displayScore) ? (
                              <span className={displayIsPass ? 'text-green-600' : 'text-red-600'}>{formatFitnessScore(item, displayScore)}</span>
                            ) : typeof displayScore === 'string' && displayScore.trim() !== '' ? (
                              <span className={displayIsPass ? 'text-green-600' : 'text-red-600'}>{formatFitnessScore(item, displayScore)}</span>
                            ) : (
                              <span className="text-gray-400 italic">未参考</span>
                            )}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td colSpan={2} className="px-4 py-4 border-b bg-gray-50">
                              <div style={{ height: '300px' }}>
                                <ReactECharts 
                                  option={getFitnessLineChartOption(item, history, isFemale)} 
                                  style={{ height: '100%', width: '100%' }} 
                                />
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  });
                
                return (
                  <>
                    <div className="overflow-x-auto mb-4">
                      <table className="w-full border-collapse border border-gray-200 rounded-xl overflow-hidden">
                        <thead className="bg-green-50">
                          <tr>
                            <th className="px-4 py-3 text-left text-sm font-semibold text-gray-600 border-b">项目</th>
                            <th className="px-4 py-3 text-left text-sm font-semibold text-gray-600 border-b">成绩</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tableRows}
                        </tbody>
                      </table>
                    </div>
                    
                    {fitnessScoresDisplay.hasFail && (
                      <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                        <p className="text-red-700 font-medium">体能不及格</p>
                      </div>
                    )}
                    
                    {fitnessScoresDisplay.hasUnreference && (
                      <div className="mb-4 p-3 bg-orange-50 border border-orange-200 rounded-lg">
                        <p className="text-orange-700 font-medium">伤病号</p>
                      </div>
                    )}
                    
                    {/* 二级评分 */}
                    {lastWeekSubScores && lastWeekSubScores.subItemScores && (
                      <div className="mb-4 p-4 bg-green-50 border border-green-100 rounded-xl">
                        <h3 className="text-lg font-bold text-green-700 mb-3">
                          第{lastWeekSubScores.week}周体能素质二级评分
                        </h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          {dimensions.find(d => d.key === 'fitness')?.subItems.map(subItem => {
                            const scoreKey = `fitness_${subItem.key}`;
                            const score = lastWeekSubScores.subItemScores[scoreKey];
                            return (
                              <div key={subItem.key} className="flex justify-between items-center p-3 bg-white rounded-lg">
                                <span className="text-sm text-gray-700">{subItem.label}</span>
                                <span className="font-bold text-green-600">
                                  {score !== undefined && score !== null ? score.toFixed(1) : '-'}
                                  <span className="text-xs text-gray-400 ml-1">/{subItem.maxScore}</span>
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
            <div className="p-4 border-t border-gray-200">
              <button
                onClick={() => setShowFitnessModal(false)}
                className="w-full px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 人文素养弹窗 */}
      {showLiteracyModal && selectedMemberDetail && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200 bg-gradient-to-r from-purple-500 to-purple-600">
              <h2 className="text-xl font-bold text-white">人文素养</h2>
              <button
                onClick={() => setShowLiteracyModal(false)}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {/* 活动经历 */}
              <div className="mb-6">
                <h3 className="text-lg font-bold text-purple-700 mb-3 flex items-center gap-2">
                  <span>🎭</span> 活动经历
                </h3>
                {(() => {
                  const activityExperiences = experiences.filter(e => e.type === 'activity');
                  if (activityExperiences.length === 0) {
                    return <p className="text-gray-500 text-sm">暂无活动经历</p>;
                  }
                  return (
                    <div className="space-y-2">
                      {activityExperiences
                        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                        .map(exp => (
                          <div key={exp.id} className="p-3 bg-purple-50 rounded-lg border-l-4 border-purple-500">
                            <p className="font-medium text-gray-900">{exp.data.name}</p>
                            {exp.data.award && (
                              <p className="text-sm text-purple-600 mt-1">🏆 {exp.data.award}</p>
                            )}
                            <p className="text-xs text-gray-400 mt-1">
                              {new Date(exp.createdAt).toLocaleDateString('zh-CN')}
                            </p>
                          </div>
                        ))}
                    </div>
                  );
                })()}
              </div>

              {/* 二级评分 */}
              {lastWeekSubScores && lastWeekSubScores.subItemScores && (
                <div className="p-4 bg-purple-50 border border-purple-100 rounded-xl">
                  <h3 className="text-lg font-bold text-purple-700 mb-3">
                    第{lastWeekSubScores.week}周人文素养二级评分
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {dimensions.find(d => d.key === 'literacy')?.subItems.map(subItem => {
                      const scoreKey = `literacy_${subItem.key}`;
                      const score = lastWeekSubScores.subItemScores[scoreKey];
                      return (
                        <div key={subItem.key} className="flex justify-between items-center p-3 bg-white rounded-lg">
                          <span className="text-sm text-gray-700">{subItem.label}</span>
                          <span className="font-bold text-purple-600">
                            {score !== undefined && score !== null ? score.toFixed(1) : '-'}
                            <span className="text-xs text-gray-400 ml-1">/{subItem.maxScore}</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            <div className="p-4 border-t border-gray-200">
              <button
                onClick={() => setShowLiteracyModal(false)}
                className="w-full px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 遵章守纪弹窗 */}
      {showDisciplineModal && selectedMemberDetail && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200 bg-gradient-to-r from-red-500 to-red-600">
              <h2 className="text-xl font-bold text-white">遵章守纪</h2>
              <button
                onClick={() => setShowDisciplineModal(false)}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {/* 遵章守纪总分 */}
              {selectedMemberDetail?.member?.id && disciplineScores[selectedMemberDetail.member.id] !== undefined && (
                <div className="mb-6 p-4 rounded-xl bg-gradient-to-r from-red-500 to-orange-500 text-white">
                  <p className="text-sm opacity-80">遵章守纪总分（初始80分）</p>
                  <p className="text-3xl font-bold mt-1">{disciplineScores[selectedMemberDetail.member.id].toFixed(1)}</p>
                </div>
              )}
              {/* 通报记录 */}
              <div className="mb-6">
                <h3 className="text-lg font-bold text-red-700 mb-3 flex items-center gap-2">
                  <span>⚠️</span> 通报记录
                </h3>
                {(() => {
                  if (notices.length === 0) {
                    return <p className="text-gray-500 text-sm">暂无通报记录</p>;
                  }
                  return (
                    <div className="space-y-3">
                      {notices
                        .sort((a, b) => new Date(b.time) - new Date(a.time))
                        .map(notice => (
                          <div key={notice.id} className="p-4 bg-red-50 rounded-xl border-l-4 border-red-500 relative">
                            {isAdmin && (
                              <button
                                onClick={() => handleDeleteNotice(notice.id)}
                                className="absolute top-2 right-2 p-1 text-red-400 hover:text-red-600 transition-colors"
                              >
                                <X size={16} />
                              </button>
                            )}
                            <p className="font-medium text-gray-900 pr-8">{notice.content}</p>
                            <p className="text-sm text-red-600 mt-1">
                              📅 {notice.time}
                            </p>
                            <p className="text-xs text-gray-400 mt-1">
                              {new Date(notice.createdAt).toLocaleDateString('zh-CN')}
                            </p>
                          </div>
                        ))}
                    </div>
                  );
                })()}
              </div>

              {/* 表彰经历 */}
              <div className="mb-6">
                <h3 className="text-lg font-bold text-red-700 mb-3 flex items-center gap-2">
                  <span>🏆</span> 表彰经历
                </h3>
                {(() => {
                  const honorExperiences = experiences.filter(e => e.type === 'honor');
                  if (honorExperiences.length === 0) {
                    return <p className="text-gray-500 text-sm">暂无表彰经历</p>;
                  }
                  return (
                    <div className="space-y-3">
                      {honorExperiences
                        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                        .map(exp => (
                          <div key={exp.id} className="p-4 bg-yellow-50 rounded-xl border-l-4 border-yellow-500">
                            <p className="font-medium text-gray-900">{exp.data.content}</p>
                            {exp.data.time && (
                              <p className="text-sm text-yellow-600 mt-1">
                                📅 {exp.data.time}
                              </p>
                            )}
                            <p className="text-xs text-gray-400 mt-1">
                              {new Date(exp.createdAt).toLocaleDateString('zh-CN')}
                            </p>
                          </div>
                        ))}
                    </div>
                  );
                })()}
              </div>

              {/* 二级评分 */}
              {lastWeekSubScores && lastWeekSubScores.subItemScores && (
                <div className="p-4 bg-red-50 border border-red-100 rounded-xl">
                  <h3 className="text-lg font-bold text-red-700 mb-3">
                    第{lastWeekSubScores.week}周遵章守纪二级评分
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {dimensions.find(d => d.key === 'discipline')?.subItems.map(subItem => {
                      const scoreKey = `discipline_${subItem.key}`;
                      const score = lastWeekSubScores.subItemScores[scoreKey];
                      return (
                        <div key={subItem.key} className="flex justify-between items-center p-3 bg-white rounded-lg">
                          <span className="text-sm text-gray-700">{subItem.label}</span>
                          <span className="font-bold text-red-600">
                            {score !== undefined && score !== null ? score.toFixed(1) : '-'}
                            <span className="text-xs text-gray-400 ml-1">/{subItem.maxScore}</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            <div className="p-4 border-t border-gray-200">
              <button
                onClick={() => setShowDisciplineModal(false)}
                className="w-full px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 班级贡献弹窗 */}
      {showContributionModal && selectedMemberDetail && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200 bg-gradient-to-r from-teal-500 to-teal-600">
              <h2 className="text-xl font-bold text-white">班级贡献</h2>
              <button
                onClick={() => setShowContributionModal(false)}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {/* 公差记录 */}
              <div className="mb-6">
                <h3 className="text-lg font-bold text-teal-700 mb-3 flex items-center gap-2">
                  <span>🔧</span> 公差记录
                  {(() => {
                    const startDateStr = config.startDate || '2026-03-02T00:00:00+08:00';
                    const currentWeek = config.currentWeek || getCurrentWeekNumber();
                    const currentWeekDuties = duties.filter(duty => {
                      const dutyWeek = calculateWeek(new Date(duty.time), startDateStr);
                      return dutyWeek === currentWeek;
                    });
                    return (
                      <span className="text-sm font-normal text-teal-600">
                        (第{currentWeek}周，共{currentWeekDuties.reduce((s, d) => s + (d.count || 1), 0)}次)
                      </span>
                    );
                  })()}
                </h3>
                {(() => {
                  const startDateStr = config.startDate || '2026-03-02T00:00:00+08:00';
                  const currentWeek = config.currentWeek || getCurrentWeekNumber();
                  const currentWeekDuties = duties.filter(duty => {
                    const dutyWeek = calculateWeek(new Date(duty.time), startDateStr);
                    return dutyWeek === currentWeek;
                  });
                  
                  if (currentWeekDuties.reduce((s, d) => s + (d.count || 1), 0) === 0) {
                    return <p className="text-gray-500 text-sm">本周暂无公差记录</p>;
                  }
                  return (
                    <div className="space-y-3">
                      {currentWeekDuties
                        .sort((a, b) => new Date(b.time) - new Date(a.time))
                        .map(duty => (
                          <div key={duty.id} className="p-4 bg-yellow-50 rounded-xl border-l-4 border-yellow-500 relative">
                            {(isAdmin || isMonitor(selectedMemberDetail.member)) && (
                              <button
                                onClick={() => handleDeleteDuty(duty.id)}
                                className="absolute top-2 right-2 p-1 text-yellow-400 hover:text-yellow-600 transition-colors"
                              >
                                <X size={16} />
                              </button>
                            )}
                            <p className="font-medium text-gray-900 pr-8">
                              {(() => {
                                const lines = (duty.content || '').split('\n').filter(l => l.trim());
                                if (lines.length <= 1) return <>{duty.content}{duty.count > 1 && <span className="ml-1 text-xs text-yellow-600 font-bold">×{duty.count}</span>}</>;
                                const show = lines.slice(0, 3);
                                return <>{show.map((l, i) => <span key={i}>{l}{i < show.length - 1 && <br />}</span>)}{lines.length > 3 && <><br /><span className="text-gray-400 text-xs">...共{lines.length}项</span></>}{duty.count > 1 && <span className="ml-1 text-xs text-yellow-600 font-bold">×{duty.count}</span>}</>;
                              })()}
                            </p>
                            <p className="text-sm text-yellow-600 mt-1">
                              📅 {duty.time}
                            </p>
                            {duty.score !== null && duty.score !== undefined && (
                              <p className="text-sm font-bold text-yellow-700 mt-1">
                                ⭐ 计分：{duty.score}
                              </p>
                            )}
                            <p className="text-xs text-gray-400 mt-1">
                              {new Date(duty.createdAt).toLocaleDateString('zh-CN')}
                            </p>
                          </div>
                        ))}
                    </div>
                  );
                })()}
              </div>

              {/* 二级评分 */}
              {lastWeekSubScores && lastWeekSubScores.subItemScores && (
                <div className="p-4 bg-teal-50 border border-teal-100 rounded-xl">
                  <h3 className="text-lg font-bold text-teal-700 mb-3">
                    第{lastWeekSubScores.week}周班级贡献二级评分
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {dimensions.find(d => d.key === 'contribution')?.subItems.map(subItem => {
                      const scoreKey = `contribution_${subItem.key}`;
                      const score = lastWeekSubScores.subItemScores[scoreKey];
                      return (
                        <div key={subItem.key} className="flex justify-between items-center p-3 bg-white rounded-lg">
                          <span className="text-sm text-gray-700">{subItem.label}</span>
                          <span className="font-bold text-teal-600">
                            {score !== undefined && score !== null ? score.toFixed(1) : '-'}
                            <span className="text-xs text-gray-400 ml-1">/{subItem.maxScore}</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            <div className="p-4 border-t border-gray-200">
              <button
                onClick={() => setShowContributionModal(false)}
                className="w-full px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 管理能力弹窗 */}
      {showManagementModal && selectedMemberDetail && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200 bg-gradient-to-r from-orange-500 to-orange-600">
              <h2 className="text-xl font-bold text-white">管理能力</h2>
              <button
                onClick={() => setShowManagementModal(false)}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {/* 骨干信息 */}
              <div className="mb-6">
                <h3 className="text-lg font-bold text-orange-700 mb-3 flex items-center gap-2">
                  <span>👤</span> 骨干信息
                </h3>
                <div className="p-4 bg-orange-50 rounded-xl border-l-4 border-orange-500">
                  <p className="text-gray-900">
                    <span className="font-medium">骨干：</span>
                    {selectedMemberDetail.member.isBackbone ? '是' : '否'}
                  </p>
                  {selectedMemberDetail.member.position && (
                    <p className="text-orange-600 mt-2">
                      <span className="font-medium">岗位：</span>{selectedMemberDetail.member.position}
                    </p>
                  )}
                </div>
              </div>

              {/* 二级评分 */}
              {lastWeekSubScores && lastWeekSubScores.subItemScores && (
                <div className="p-4 bg-orange-50 border border-orange-100 rounded-xl">
                  <h3 className="text-lg font-bold text-orange-700 mb-3">
                    第{lastWeekSubScores.week}周管理能力二级评分
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {dimensions.find(d => d.key === 'management')?.subItems.map(subItem => {
                      const scoreKey = `management_${subItem.key}`;
                      const score = lastWeekSubScores.subItemScores[scoreKey];
                      return (
                        <div key={subItem.key} className="flex justify-between items-center p-3 bg-white rounded-lg">
                          <span className="text-sm text-gray-700">{subItem.label}</span>
                          <span className="font-bold text-orange-600">
                            {score !== undefined && score !== null ? score.toFixed(1) : '-'}
                            <span className="text-xs text-gray-400 ml-1">/{subItem.maxScore}</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            <div className="p-4 border-t border-gray-200">
              <button
                onClick={() => setShowManagementModal(false)}
                className="w-full px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 通报密码验证 Modal */}
      {showNoticePasswordModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm">
            <div className="flex items-center justify-between p-6 border-b border-gray-200 bg-gradient-to-r from-red-500 to-red-600">
              <h2 className="text-xl font-bold text-white">验证密码</h2>
              <button
                onClick={() => setShowNoticePasswordModal(false)}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-gray-600">请输入密码以使用通报功能</p>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  密码
                </label>
                <input
                  type="password"
                  value={noticePassword}
                  onChange={(e) => setNoticePassword(e.target.value)}
                  placeholder="请输入密码"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      if (noticePassword === '11111111') {
                        setShowNoticePasswordModal(false);
                        setNoticeForm({
                          class: targetMember?.class || selectedClass || '',
                          memberId: targetMember?.id || '',
                          content: '',
                          time: new Date().toISOString().split('T')[0]
                        });
                        setShowNoticeModal(true);
                      } else {
                        showNotification('密码错误', 'error');
                      }
                    }
                  }}
                />
              </div>
              <div className="flex gap-3 pt-4">
                <button
                  onClick={() => setShowNoticePasswordModal(false)}
                  className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={() => {
                    if (noticePassword === '11111111') {
                      setShowNoticePasswordModal(false);
                      setNoticeForm({
                        class: targetMember?.class || selectedClass || '',
                        memberId: targetMember?.id || '',
                        content: '',
                        time: new Date().toISOString().split('T')[0]
                      });
                      setShowNoticeModal(true);
                    } else {
                      showNotification('密码错误', 'error');
                    }
                  }}
                  className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                >
                  验证
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 通报 Modal */}
      {showNoticeModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200 bg-gradient-to-r from-red-500 to-red-600">
              <h2 className="text-xl font-bold text-white">添加通报</h2>
              <button
                onClick={() => setShowNoticeModal(false)}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  选择班级 <span className="text-red-500">*</span>
                </label>
                <select
                  value={noticeForm.class}
                  onChange={(e) => setNoticeForm({ ...noticeForm, class: e.target.value, memberId: '' })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500"
                >
                  <option value="">请选择班级</option>
                  {classes.map(c => (
                    <option key={c} value={c}>{maskClassName(c)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  选择成员 <span className="text-red-500">*</span>
                </label>
                <select
                  value={noticeForm.memberId}
                  onChange={(e) => setNoticeForm({ ...noticeForm, memberId: e.target.value })}
                  disabled={!noticeForm.class}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <option value="">请选择成员</option>
                  {noticeForm.class && members
                    .filter(m => m.class === noticeForm.class)
                    .map(member => (
                      <option key={member.id} value={member.id}>
                        {maskName(member.name)}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  通报时间 <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  value={noticeForm.time}
                  onChange={(e) => setNoticeForm({ ...noticeForm, time: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  通报内容 <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={noticeForm.content}
                  onChange={(e) => setNoticeForm({ ...noticeForm, content: e.target.value })}
                  rows={4}
                  placeholder="请输入通报内容..."
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500 resize-none"
                />
              </div>
            </div>
            <div className="flex gap-3 p-6 border-t border-gray-200">
              <button
                onClick={() => setShowNoticeModal(false)}
                className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSaveNotice}
                disabled={!noticeForm.memberId || !noticeForm.content || savingNotice}
                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {savingNotice ? (
                  <>
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    保存中...
                  </>
                ) : (
                  '保存'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 公差计分 Modal */}
      {showDutyModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200 bg-gradient-to-r from-yellow-500 to-yellow-600">
              <h2 className="text-xl font-bold text-white">公差计分</h2>
              <button
                onClick={() => setShowDutyModal(false)}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {/* 已有公差记录 */}
              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-2">
                  已有公差记录
                  <span className="text-xs text-gray-500 ml-1">（第{config.currentWeek || getCurrentWeekNumber()}周）</span>
                </h3>
                <div className="max-h-40 overflow-y-auto border border-gray-300 rounded-lg p-3 bg-gray-50 space-y-2">
                  {(() => {
                    const startDateStr = config.startDate || '2026-03-02T00:00:00+08:00';
                    const currentWeek = config.currentWeek || getCurrentWeekNumber();
                    
                    const currentWeekDuties = duties.filter(duty => {
                      if (duty.class !== (selectedMemberDetail?.member?.class || currentUser?.class || selectedClass)) {
                        return false;
                      }
                      const dutyWeek = calculateWeek(new Date(duty.time), startDateStr);
                      return dutyWeek === currentWeek;
                    }).sort((a, b) => new Date(b.time) - new Date(a.time));
                    
                    if (currentWeekDuties.reduce((s, d) => s + (d.count || 1), 0) === 0) {
                      return <p className="text-sm text-gray-500 text-center py-2">本周暂无公差记录</p>;
                    }
                    
                    return currentWeekDuties.map(duty => (
                      <div key={duty.id} className="p-3 bg-yellow-50 rounded-lg border-l-3 border-yellow-500 relative">
                        <div className="flex justify-between items-start">
                          <div className="flex-1 pr-8">
                            <p className="font-medium text-gray-900 text-sm">
                              {(() => {
                                const lines = (duty.content || '').split('\n').filter(l => l.trim());
                                if (lines.length <= 1) return <>{duty.content}{duty.count > 1 && <span className="ml-1 text-xs text-yellow-600 font-bold">×{duty.count}</span>}</>;
                                const show = lines.slice(0, 3);
                                return <>{show.map((l, i) => <span key={i}>{l}{i < show.length - 1 && <br />}</span>)}{lines.length > 3 && <><br /><span className="text-gray-400 text-xs">...共{lines.length}项</span></>}{duty.count > 1 && <span className="ml-1 text-xs text-yellow-600 font-bold">×{duty.count}</span>}</>;
                              })()}
                            </p>
                            <p className="text-xs text-yellow-600 mt-1">
                              {new Date(duty.time).toLocaleDateString('zh-CN')} · 
                              {duty.memberIds.map(id => {
                                const member = members.find(m => m.id === id);
                                return member ? maskName(member.name) : id;
                              }).join('、')}
                            </p>
                            {duty.score !== null && duty.score !== undefined && (
                              <p className="text-xs text-green-600 mt-1">+{duty.score}分</p>
                            )}
                          </div>
                          <button
                            onClick={() => handleDeleteDuty(duty.id)}
                            className="absolute top-2 right-2 p-1 text-yellow-400 hover:text-yellow-600 transition-colors"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      </div>
                    ));
                  })()}
                </div>
              </div>
              
              <div className="border-t border-gray-200 pt-4">
                <h3 className="text-sm font-medium text-gray-700 mb-2">添加新公差</h3>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  公差人员 <span className="text-red-500">*</span>
                </label>
                <div className="max-h-48 overflow-y-auto border border-gray-300 rounded-lg p-3 bg-gray-50">
                  {(() => {
                    const classMembers = members
                      .filter(m => m.class === (selectedMemberDetail?.member?.class || currentUser?.class || selectedClass));
                    
                    // 找出公差次数最少和公差分最少的成员
                    if (classMembers.length > 0) {
                      let minCount = Infinity;
                      let minScore = Infinity;
                      classMembers.forEach(member => {
                        const stats = dutyStats[member.id] || { count: 0, totalScore: 0 };
                        if (stats.count < minCount) minCount = stats.count;
                        if (stats.totalScore < minScore) minScore = stats.totalScore;
                      });
                      
                      return classMembers.map(member => {
                        const stats = dutyStats[member.id] || { count: 0, totalScore: 0 };
                        const isMinCount = stats.count === minCount;
                        const isMinScore = stats.totalScore === minScore;
                        
                        return (
                          <label key={member.id} className={`flex items-center justify-between py-2 cursor-pointer hover:bg-gray-100 rounded px-2 ${
                            isMinCount || isMinScore ? 'bg-blue-50' : ''
                          }`}>
                            <div className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={dutyForm.memberIds.includes(member.id)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setDutyForm({ ...dutyForm, memberIds: [...dutyForm.memberIds, member.id] });
                                  } else {
                                    setDutyForm({ ...dutyForm, memberIds: dutyForm.memberIds.filter(id => id !== member.id) });
                                  }
                                }}
                                className="w-4 h-4 text-yellow-600 rounded focus:ring-yellow-500"
                              />
                              <div className="flex items-center gap-2">
                                <span className="text-sm text-gray-700">{maskName(member.name)}</span>
                                {isMinCount && (
                                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-blue-500 text-white font-medium">
                                    次数最少
                                  </span>
                                )}
                                {isMinScore && (
                                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-purple-500 text-white font-medium">
                                    积分最少
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className={`text-xs px-2 py-0.5 rounded-full ${
                                stats.count >= 3 
                                  ? 'bg-yellow-100 text-yellow-700' 
                                  : 'bg-gray-100 text-gray-500'
                              }`}>
                                {stats.count}次
                              </span>
                              {stats.totalScore > 0 && (
                                <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                                  +{stats.totalScore.toFixed(1)}
                                </span>
                              )}
                            </div>
                          </label>
                        );
                      });
                    }
                    return null;
                  })()}
                </div>
                {dutyForm.memberIds.length > 0 && (
                  <p className="text-xs text-gray-500 mt-1">
                    已选择 {dutyForm.memberIds.length} 人
                  </p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  公差时间 <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  value={dutyForm.time}
                  onChange={(e) => setDutyForm({ ...dutyForm, time: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-yellow-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  公差内容 <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={dutyForm.content}
                  onChange={(e) => setDutyForm({ ...dutyForm, content: e.target.value })}
                  rows={3}
                  placeholder="请输入公差内容..."
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-yellow-500 resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  计分（可选）
                </label>
                <input
                  type="number"
                  step="0.5"
                  value={dutyForm.score}
                  onChange={(e) => setDutyForm({ ...dutyForm, score: e.target.value })}
                  placeholder="例如：1.5"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-yellow-500"
                />
              </div>
            </div>
            <div className="flex gap-3 p-6 border-t border-gray-200">
              <button
                onClick={() => setShowDutyModal(false)}
                className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSaveDuty}
                disabled={!dutyForm.memberIds || dutyForm.memberIds.length === 0 || !dutyForm.content || !dutyForm.time || savingDuty}
                className="flex-1 px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {savingDuty ? (
                  <>
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    保存中...
                  </>
                ) : (
                  '保存'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 我的经历 Modal */}
      {showExperiencesModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 className="text-xl font-bold text-gray-900">我的经历</h2>
              <button
                onClick={() => setShowExperiencesModal(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* 类型选择 */}
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => setExperienceType('activity')}
                  className={`flex-1 min-w-[80px] px-3 py-2 rounded-lg font-medium transition-all ${
                    experienceType === 'activity'
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  活动
                </button>
                <button
                  onClick={() => setExperienceType('competition')}
                  className={`flex-1 min-w-[80px] px-3 py-2 rounded-lg font-medium transition-all ${
                    experienceType === 'competition'
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  竞赛
                </button>
                <button
                  onClick={() => setExperienceType('research')}
                  className={`flex-1 min-w-[80px] px-3 py-2 rounded-lg font-medium transition-all ${
                    experienceType === 'research'
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  科研
                </button>
                <button
                  onClick={() => setExperienceType('honor')}
                  className={`flex-1 min-w-[80px] px-3 py-2 rounded-lg font-medium transition-all ${
                    experienceType === 'honor'
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  表彰
                </button>
              </div>

              {/* 表单 */}
              <div className="bg-gray-50 p-4 rounded-xl space-y-4">
                <h3 className="font-semibold text-gray-900">添加经历</h3>
                {experienceType === 'activity' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        活动名称 <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={experienceForm.activityName}
                        onChange={(e) => setExperienceForm({ ...experienceForm, activityName: e.target.value })}
                        placeholder="请输入活动名称"
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        奖项（可选）
                      </label>
                      <input
                        type="text"
                        value={experienceForm.activityAward}
                        onChange={(e) => setExperienceForm({ ...experienceForm, activityAward: e.target.value })}
                        placeholder="请输入奖项"
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                    </div>
                  </div>
                )}
                {experienceType === 'competition' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        竞赛名称 <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={experienceForm.competitionName}
                        onChange={(e) => setExperienceForm({ ...experienceForm, competitionName: e.target.value })}
                        placeholder="请输入竞赛名称"
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        级别 <span className="text-red-500">*</span>
                      </label>
                      <select
                        value={experienceForm.competitionLevel}
                        onChange={(e) => setExperienceForm({ ...experienceForm, competitionLevel: e.target.value })}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                      >
                        <option value="college">院级</option>
                        <option value="school">校级</option>
                        <option value="city">市级</option>
                        <option value="province">省级</option>
                        <option value="national">全国</option>
                        <option value="international">国际</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        奖项（可选）
                      </label>
                      <input
                        type="text"
                        value={experienceForm.competitionAward}
                        onChange={(e) => setExperienceForm({ ...experienceForm, competitionAward: e.target.value })}
                        placeholder="请输入奖项"
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                    </div>
                  </div>
                )}
                {experienceType === 'research' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        项目名称 <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={experienceForm.researchName}
                        onChange={(e) => setExperienceForm({ ...experienceForm, researchName: e.target.value })}
                        placeholder="请输入项目名称"
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="hasAdvisor"
                        checked={experienceForm.researchHasAdvisor}
                        onChange={(e) => setExperienceForm({ ...experienceForm, researchHasAdvisor: e.target.checked })}
                        className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500"
                      />
                      <label htmlFor="hasAdvisor" className="text-sm text-gray-700">
                        已签约导师
                      </label>
                    </div>
                  </div>
                )}
                {experienceType === 'honor' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        表彰内容 <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={experienceForm.honorContent}
                        onChange={(e) => setExperienceForm({ ...experienceForm, honorContent: e.target.value })}
                        placeholder="请输入表彰内容"
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        时间（可选）
                      </label>
                      <input
                        type="date"
                        value={experienceForm.honorTime}
                        onChange={(e) => setExperienceForm({ ...experienceForm, honorTime: e.target.value })}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                    </div>
                  </div>
                )}
                <button
                  onClick={() => {
                    if (!selectedMemberDetail?.member?.id || !currentUser?.id) return;
                    let data = {};
                    if (experienceType === 'activity') {
                      if (!experienceForm.activityName.trim()) {
                        showNotification('请填写活动名称', 'error');
                        return;
                      }
                      data = {
                        name: experienceForm.activityName,
                        award: experienceForm.activityAward
                      };
                    } else if (experienceType === 'competition') {
                      if (!experienceForm.competitionName.trim()) {
                        showNotification('请填写竞赛名称', 'error');
                        return;
                      }
                      data = {
                        name: experienceForm.competitionName,
                        level: experienceForm.competitionLevel,
                        award: experienceForm.competitionAward
                      };
                    } else if (experienceType === 'research') {
                      if (!experienceForm.researchName.trim()) {
                        showNotification('请填写项目名称', 'error');
                        return;
                      }
                      data = {
                        name: experienceForm.researchName,
                        hasAdvisor: experienceForm.researchHasAdvisor
                      };
                    } else if (experienceType === 'honor') {
                      if (!experienceForm.honorContent.trim()) {
                        showNotification('请填写表彰内容', 'error');
                        return;
                      }
                      data = {
                        content: experienceForm.honorContent,
                        time: experienceForm.honorTime
                      };
                    }
                    addExperience(selectedMemberDetail.member.id, currentUser.id, experienceType, data);
                  }}
                  className="w-full px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-medium"
                >
                  添加
                </button>
              </div>

              {/* 经历列表 */}
              <div className="space-y-4">
                <h3 className="font-semibold text-gray-900">经历记录</h3>
                {loadingExperiences ? (
                  <div className="text-center py-8 text-gray-500">加载中...</div>
                ) : experiences.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">暂无经历记录</div>
                ) : (
                  <div className="space-y-3">
                    {experiences
                      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                      .map((exp) => {
                        const canDelete = exp.uploaderId === currentUser?.id || currentUser?.id === 'superadmin';
                        const levelLabels = {
                          college: '院级',
                          school: '校级',
                          city: '市级',
                          province: '省级',
                          national: '全国',
                          international: '国际'
                        };
                        let displayText = '';
                        let themeColor = 'blue';
                        if (exp.type === 'activity') {
                          themeColor = 'purple';
                          displayText = exp.data.name + (exp.data.award ? ` · ${exp.data.award}` : '');
                        } else if (exp.type === 'competition') {
                          themeColor = 'green';
                          displayText = `${levelLabels[exp.data.level]} · ${exp.data.name}` + (exp.data.award ? ` · ${exp.data.award}` : '');
                        } else if (exp.type === 'research') {
                          themeColor = 'orange';
                          displayText = exp.data.name + (exp.data.hasAdvisor ? ' · 已签约导师' : '');
                        } else if (exp.type === 'honor') {
                          themeColor = 'yellow';
                          displayText = exp.data.content;
                        }
                        return (
                          <div key={exp.id} className={`p-4 rounded-xl border-l-4 ${
                            themeColor === 'purple' ? 'bg-purple-50 border-purple-500' :
                            themeColor === 'green' ? 'bg-green-50 border-green-500' :
                            themeColor === 'yellow' ? 'bg-yellow-50 border-yellow-500' :
                            'bg-orange-50 border-orange-500'
                          }`}>
                            <div className="flex justify-between items-start">
                              <div>
                                <p className="font-medium text-gray-900">{displayText}</p>
                                {exp.type === 'honor' && exp.data.time && (
                                  <p className="text-xs text-yellow-600 mt-1">
                                    📅 {exp.data.time}
                                  </p>
                                )}
                                <p className="text-xs text-gray-500 mt-1">
                                  {new Date(exp.createdAt).toLocaleDateString('zh-CN')}
                                </p>
                              </div>
                              {canDelete && (
                                <button
                                  onClick={() => deleteExperience(exp.id, selectedMemberDetail?.member?.id)}
                                  className="text-red-500 hover:text-red-700 transition-colors"
                                >
                                  <X size={18} />
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            </div>
            <div className="p-6 border-t border-gray-200">
              <button
                onClick={() => setShowExperiencesModal(false)}
                className="w-full px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors font-medium"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 心理气象站弹窗 */}
      {showPsychologicalStationModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200 bg-gradient-to-r from-purple-600 to-purple-700">
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <HeartPulse size={24} />
                心理气象站
              </h2>
              <button
                onClick={() => setShowPsychologicalStationModal(false)}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            
            {/* 标签页导航 */}
            <div className="flex border-b border-gray-200 bg-gray-50">
              <button
                onClick={() => {
                  setPsychologicalStationTab('alerts');
                  fetchAlerts();
                }}
                className={`flex-1 px-6 py-4 font-medium text-sm transition-colors ${
                  psychologicalStationTab === 'alerts'
                    ? 'text-purple-600 border-b-2 border-purple-600 bg-white'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                预警看板
              </button>
              <button
                onClick={() => {
                  setPsychologicalStationTab('social-map');
                  fetchSocialMap(null, selectedMapClass || undefined);
                }}
                className={`flex-1 px-6 py-4 font-medium text-sm transition-colors ${
                  psychologicalStationTab === 'social-map'
                    ? 'text-purple-600 border-b-2 border-purple-600 bg-white'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                社交地形图
              </button>
              <button
                onClick={() => {
                  setPsychologicalStationTab('compatibility');
                }}
                className={`flex-1 px-6 py-4 font-medium text-sm transition-colors ${
                  psychologicalStationTab === 'compatibility'
                    ? 'text-purple-600 border-b-2 border-purple-600 bg-white'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                相容性分析
              </button>
              <button
                onClick={() => {
                  setPsychologicalStationTab('counseling');
                }}
                className={`flex-1 px-6 py-4 font-medium text-sm transition-colors ${
                  psychologicalStationTab === 'counseling'
                    ? 'text-purple-600 border-b-2 border-purple-600 bg-white'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                心理咨询
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6">
              {loadingPsychologicalData ? (
                <div className="flex items-center justify-center py-12">
                  <div className="w-8 h-8 border-4 border-purple-600 border-t-transparent rounded-full animate-spin"></div>
                </div>
              ) : (
                <>
                  {/* 预警看板 */}
                  {psychologicalStationTab === 'alerts' && alertData && (
                    <div className="space-y-6">
                      {/* 红黄绿卡片 */}
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {/* 红码 */}
                        <div 
                          className="bg-red-50 border-2 border-red-200 rounded-xl p-6 cursor-pointer hover:bg-red-100 transition-colors"
                          onClick={() => {
                            setSelectedAlertType('red');
                            setShowAlertModal(true);
                          }}
                        >
                          <div className="flex items-center justify-between mb-4">
                            <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center">
                              <AlertTriangle size={24} className="text-red-600" />
                            </div>
                            <span className="text-3xl font-bold text-red-600">{alertData.summary.red}</span>
                          </div>
                          <h3 className="font-bold text-red-800">红码（高危）</h3>
                          <p className="text-sm text-red-600 mt-1">社交孤立高风险</p>
                          <p className="text-xs text-red-500 mt-2">点击查看详情 →</p>
                        </div>
                        
                        {/* 黄码 */}
                        <div 
                          className="bg-yellow-50 border-2 border-yellow-200 rounded-xl p-6 cursor-pointer hover:bg-yellow-100 transition-colors"
                          onClick={() => {
                            setSelectedAlertType('yellow');
                            setShowAlertModal(true);
                          }}
                        >
                          <div className="flex items-center justify-between mb-4">
                            <div className="w-12 h-12 bg-yellow-100 rounded-full flex items-center justify-center">
                              <AlertTriangle size={24} className="text-yellow-600" />
                            </div>
                            <span className="text-3xl font-bold text-yellow-600">{alertData.summary.yellow}</span>
                          </div>
                          <h3 className="font-bold text-yellow-800">黄码（波动）</h3>
                          <p className="text-sm text-yellow-600 mt-1">人际摩擦预警</p>
                          <p className="text-xs text-yellow-500 mt-2">点击查看详情 →</p>
                        </div>
                        
                        {/* 绿码 */}
                        <div 
                          className="bg-green-50 border-2 border-green-200 rounded-xl p-6 cursor-pointer hover:bg-green-100 transition-colors"
                          onClick={() => {
                            setSelectedAlertType('green');
                            setShowAlertModal(true);
                          }}
                        >
                          <div className="flex items-center justify-between mb-4">
                            <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
                              <CheckCircle2 size={24} className="text-green-600" />
                            </div>
                            <span className="text-3xl font-bold text-green-600">{alertData.summary.green}</span>
                          </div>
                          <h3 className="font-bold text-green-800">绿码（资源）</h3>
                          <p className="text-sm text-green-600 mt-1">同伴支持资源</p>
                          <p className="text-xs text-green-500 mt-2">点击查看详情 →</p>
                        </div>
                      </div>
                      
                      {/* 预警列表 */}
                      <div className="bg-white border border-gray-200 rounded-xl">
                        <div className="p-4 border-b border-gray-200">
                          <h3 className="font-bold text-gray-900">预警名单</h3>
                        </div>
                        <div className="divide-y divide-gray-100">
                          {alertData.alerts
                            .slice((alertPage - 1) * alertsPerPage, alertPage * alertsPerPage)
                            .map((alert) => (
                              <div 
                                key={alert.memberId}
                                className={`p-4 cursor-pointer hover:bg-gray-50 transition-colors ${
                                  alert.alertLevel === 'red' ? 'bg-red-50' :
                                  alert.alertLevel === 'yellow' ? 'bg-yellow-50' :
                                  'bg-green-50'
                                }`}
                                onClick={() => {
                                  setSelectedMapMemberId(alert.memberId);
                                  setPsychologicalStationTab('social-map');
                                  fetchSocialMap(null, selectedMapClass || undefined);
                                }}
                              >
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-3">
                                    <div className={`w-3 h-3 rounded-full ${
                                      alert.alertLevel === 'red' ? 'bg-red-500' :
                                      alert.alertLevel === 'yellow' ? 'bg-yellow-500' :
                                      'bg-green-500'
                                    }`}></div>
                                    <div>
                                      <p className="font-medium text-gray-900">
                                        {alert.memberName} ({alert.mbti || '未知'})
                                      </p>
                                      <p className="text-sm text-gray-600">{alert.alertText}</p>
                                    </div>
                                  </div>
                                  <ChevronRight size={20} className="text-gray-400" />
                                </div>
                              </div>
                            ))}
                        </div>
                        
                        {/* 分页 */}
                        {alertData.alerts.length > alertsPerPage && (
                          <div className="p-4 border-t border-gray-200 flex items-center justify-center gap-2">
                            <button
                              onClick={() => setAlertPage(p => Math.max(1, p - 1))}
                              disabled={alertPage === 1}
                              className="px-3 py-1 rounded border border-gray-300 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
                            >
                              上一页
                            </button>
                            <span className="text-sm text-gray-600">
                              第 {alertPage} 页 / 共 {Math.ceil(alertData.alerts.length / alertsPerPage)} 页
                            </span>
                            <button
                              onClick={() => setAlertPage(p => p + 1)}
                              disabled={alertPage >= Math.ceil(alertData.alerts.length / alertsPerPage)}
                              className="px-3 py-1 rounded border border-gray-300 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
                            >
                              下一页
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  
                  {/* 预警码详情弹窗 */}
                  {showAlertModal && selectedAlertType && (
                    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black bg-opacity-50">
                      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden">
                        <div className={`p-6 ${
                          selectedAlertType === 'red' ? 'bg-red-500 text-white' :
                          selectedAlertType === 'yellow' ? 'bg-yellow-500 text-white' :
                          'bg-green-500 text-white'
                        }`}>
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              {selectedAlertType === 'red' ? (
                                <AlertTriangle size={28} />
                              ) : selectedAlertType === 'yellow' ? (
                                <AlertTriangle size={28} />
                              ) : (
                                <CheckCircle2 size={28} />
                              )}
                              <h2 className="text-xl font-bold">
                                {selectedAlertType === 'red' ? '红码（高危）' : 
                                 selectedAlertType === 'yellow' ? '黄码（波动）' : 
                                 '绿码（资源）'}判断逻辑
                              </h2>
                            </div>
                            <button
                              onClick={() => setShowAlertModal(false)}
                              className="hover:opacity-80 transition-opacity"
                            >
                              <X size={24} />
                            </button>
                          </div>
                        </div>
                        
                        <div className="p-6 overflow-y-auto max-h-[calc(80vh-80px)]">
                          {/* 判断逻辑 */}
                          <div className="mb-6">
                            <h3 className="font-bold text-gray-900 mb-3 flex items-center gap-2">
                              <span className="w-6 h-6 bg-blue-500 text-white rounded-full flex items-center justify-center text-sm">1</span>
                              判断逻辑
                            </h3>
                            <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                              {selectedAlertType === 'red' && (
                                <>
                                  <p className="text-sm text-gray-700">• <strong>连续2次正向提名次数 = 0</strong>：连续两周没有被任何人正向提名</p>
                                  <p className="text-sm text-gray-700">• <strong>连续2次反向提名次数 ≥ 4</strong>：连续两周收到4次及以上负向提名</p>
                                </>
                              )}
                              {selectedAlertType === 'yellow' && (
                                <>
                                  <p className="text-sm text-gray-700">• <strong>连续2次负面心情</strong>：连续两周自评心情为负面状态</p>
                                  <p className="text-sm text-gray-700">• <strong>当前发起负向提名 ≥ 3次</strong>：近期频繁发起负向社交</p>
                                </>
                              )}
                              {selectedAlertType === 'green' && (
                                <>
                                  <p className="text-sm text-gray-700">• <strong>连续2次正向提名 ≥ 5</strong>：连续两周被正向提名5次及以上</p>
                                </>
                              )}
                            </div>
                          </div>
                          
                          {/* 可能表示的心理状态 */}
                          <div className="mb-6">
                            <h3 className="font-bold text-gray-900 mb-3 flex items-center gap-2">
                              <span className="w-6 h-6 bg-blue-500 text-white rounded-full flex items-center justify-center text-sm">2</span>
                              可能表示的心理状态
                            </h3>
                            <div className={`rounded-lg p-4 space-y-2 ${
                              selectedAlertType === 'red' ? 'bg-red-50 border border-red-200' :
                              selectedAlertType === 'yellow' ? 'bg-yellow-50 border border-yellow-200' :
                              'bg-green-50 border border-green-200'
                            }`}>
                              {selectedAlertType === 'red' && (
                                <>
                                  <p className="text-sm text-red-800">
                                    <strong>⚠️ 社交孤立风险</strong>：连续两周没有被正向提名，可能存在被排斥或自我封闭的情况
                                  </p>
                                  <p className="text-sm text-red-800">
                                    <strong>⚠️ 负向社交压力大</strong>：连续两周收到较多负向提名，可能面临人际冲突或社交压力
                                  </p>
                                </>
                              )}
                              {selectedAlertType === 'yellow' && (
                                <>
                                  <p className="text-sm text-yellow-800">
                                    <strong>⚡ 情绪状态波动</strong>：连续两周自评心情为负面，可能近期遇到困难或压力
                                  </p>
                                  <p className="text-sm text-yellow-800">
                                    <strong>⚡ 人际冲突倾向</strong>：频繁发起负向社交，可能与他人存在矛盾或冲突
                                  </p>
                                  <p className="text-sm text-yellow-800">
                                    <strong>⚡ 需要关注支持</strong>：建议及时给予关心和帮助
                                  </p>
                                </>
                              )}
                              {selectedAlertType === 'green' && (
                                <>
                                  <p className="text-sm text-green-800">
                                    <strong>✅ 良好的社会支持</strong>：连续两周获得较多正向提名，说明人际关系良好
                                  </p>
                                  <p className="text-sm text-green-800">
                                    <strong>✅ 班级情绪调节者</strong>：可以标记为"朋辈桥梁"角色，发挥正向影响力
                                  </p>
                                </>
                              )}
                            </div>
                          </div>
                          
                          {/* 建议关注学生 */}
                          <div>
                            <h3 className="font-bold text-gray-900 mb-3 flex items-center gap-2">
                              <span className="w-6 h-6 bg-blue-500 text-white rounded-full flex items-center justify-center text-sm">3</span>
                              当前符合此状态的学生
                            </h3>
                            <div className="bg-gray-50 rounded-lg p-4">
                              {alertData.alerts
                                .filter(a => a.alertLevel === selectedAlertType)
                                .length === 0 ? (
                                <p className="text-sm text-gray-500">暂无符合此状态的学生</p>
                              ) : (
                                <ul className="space-y-2">
                                  {alertData.alerts
                                    .filter(a => a.alertLevel === selectedAlertType)
                                    .slice(0, 5)
                                    .map((alert, idx) => (
                                      <li key={idx} className="flex items-center gap-2 text-sm">
                                        <span className={`w-2 h-2 rounded-full ${
                                          selectedAlertType === 'red' ? 'bg-red-500' :
                                          selectedAlertType === 'yellow' ? 'bg-yellow-500' :
                                          'bg-green-500'
                                        }`}></span>
                                        <span className="font-medium">{alert.memberName}</span>
                                        <span className="text-gray-500">({alert.mbti || '未知'})</span>
                                        <span className="text-gray-400">- {alert.alertText}</span>
                                      </li>
                                    ))}
                                  {alertData.alerts.filter(a => a.alertLevel === selectedAlertType).length > 5 && (
                                    <li className="text-sm text-gray-500">
                                      ...还有 {alertData.alerts.filter(a => a.alertLevel === selectedAlertType).length - 5} 名学生
                                    </li>
                                  )}
                                </ul>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                  
                  {/* 社交地形图 */}
                  {psychologicalStationTab === 'social-map' && socialMapData && (
                    <div className="space-y-6">
                      {/* 顶部工具栏 */}
                      <div className="flex flex-wrap items-center gap-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
                        {/* 班级选择器 */}
                        <div className="flex items-center gap-2">
                          <label className="text-sm font-bold text-gray-700 whitespace-nowrap">选择班级</label>
                          <select
                            value={selectedMapClass}
                            onChange={(e) => {
                              setSelectedMapClass(e.target.value);
                              fetchSocialMap(null, e.target.value || undefined);
                            }}
                            className="bg-white border border-gray-300 rounded-md px-3 py-2 text-sm text-gray-700 font-bold focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            <option value="">全校</option>
                            {classes.map((className) => (
                              <option key={className} value={className}>
                                {className}
                              </option>
                            ))}
                          </select>
                        </div>
                        
                        <div className="h-8 w-px bg-gray-300"></div>
                        
                        {/* 工具模式选择 */}
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-gray-700">分析工具:</span>
                          <button
                            onClick={() => {
                              setMapToolMode('view');
                              setInterventionSuggestion(null);
                              setSelectedGroups([]);
                            }}
                            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                              mapToolMode === 'view'
                                ? 'bg-blue-600 text-white'
                                : 'bg-white text-gray-700 hover:bg-gray-100'
                            }`}
                          >
                            查看
                          </button>
                          <button
                            onClick={() => {
                              setMapToolMode('focus-island');
                              setInterventionSuggestion(null);
                              setSelectedGroups([]);
                            }}
                            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                              mapToolMode === 'focus-island'
                                ? 'bg-orange-600 text-white'
                                : 'bg-white text-gray-700 hover:bg-gray-100'
                            }`}
                          >
                            聚焦孤岛
                          </button>
                          <button
                            onClick={() => {
                              setMapToolMode('group');
                              setInterventionSuggestion(null);
                              setSelectedGroups([]);
                            }}
                            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                              mapToolMode === 'group'
                                ? 'bg-green-600 text-white'
                                : 'bg-white text-gray-700 hover:bg-gray-100'
                            }`}
                          >
                            小团体识别
                          </button>
                          <button
                            onClick={() => {
                              setMapToolMode('bridge');
                              setInterventionSuggestion(null);
                              setSelectedBridgeGroups([]);
                              calculateBridgePersons();
                            }}
                            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                              mapToolMode === 'bridge'
                                ? 'bg-purple-600 text-white'
                                : 'bg-white text-gray-700 hover:bg-gray-100'
                            }`}
                          >
                            桥梁人推荐
                          </button>
                        </div>
                      </div>
                      
                      {/* 样式图例说明 */}
                      <div className="bg-white rounded-lg p-3 shadow-sm border border-gray-200">
                        <h3 className="font-bold text-gray-900 mb-3 text-sm">图例说明</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {/* 节点样式 */}
                          <div>
                            <h4 className="font-medium text-gray-700 mb-2 text-xs">节点样式</h4>
                            <div className="space-y-1.5">
                              <div className="flex items-center gap-2">
                                <div className="w-5 h-5 rounded-full bg-blue-500 border border-gray-300"></div>
                                <span className="text-xs text-gray-600">外向型（E）- 蓝色系</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <div className="w-5 h-5 rounded-full bg-green-500 border border-gray-300"></div>
                                <span className="text-xs text-gray-600">内向型（I）- 绿色系</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <div className="w-5 h-5 rounded-full bg-gray-400 border-2 border-yellow-400"></div>
                                <span className="text-xs text-gray-600">正向总分 - 金色光晕</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <div className="w-5 h-5 rounded-full bg-gray-400 border-2 border-purple-500"></div>
                                <span className="text-xs text-gray-600">负向总分 - 紫色光晕</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <div className="w-5 h-5 rounded-full bg-gray-400 border-2 border-red-500"></div>
                                <span className="text-xs text-gray-600">红码预警 - 红色光晕</span>
                              </div>
                            </div>
                          </div>
                          
                          {/* 连线样式 */}
                          <div>
                            <h4 className="font-medium text-gray-700 mb-2 text-xs">连线样式</h4>
                            <div className="space-y-1.5">
                              <div className="flex items-center gap-2">
                                <div className="w-12 h-1 bg-green-500"></div>
                                <span className="text-xs text-gray-600">双向正向 - 绿色粗线</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <div className="w-12 h-0.5 bg-blue-500"></div>
                                <span className="text-xs text-gray-600">单向正向 - 蓝色细线</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <div className="w-12 border-t border-dotted border-red-500"></div>
                                <span className="text-xs text-gray-600">负向提名 - 红色虚线</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                      
                      {/* ECharts 图表 */}
                      <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-200">
                        <ReactECharts
                          option={getSocialMapChartOption()}
                          style={{ height: '600px', width: '100%' }}
                          onEvents={{
                            click: handleMapNodeClick
                          }}
                        />
                      </div>
                      
                      {/* 干预建议 */}
                      {interventionSuggestion && (
                        <div className="bg-orange-50 border border-orange-200 rounded-xl p-6">
                          <h3 className="font-bold text-orange-800 mb-4 flex items-center gap-2">
                            <AlertTriangle size={20} className="text-orange-600" />
                            干预建议
                          </h3>
                          <div className="space-y-3">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              <div className="bg-white rounded-lg p-4 border border-orange-100">
                                <p className="text-sm text-gray-600">孤岛节点</p>
                                <p className="font-bold text-gray-900">
                                  {interventionSuggestion.islandNode.name} ({interventionSuggestion.islandNode.mbti || '未知'})
                                </p>
                              </div>
                              <div className="bg-white rounded-lg p-4 border border-green-100">
                                <p className="text-sm text-gray-600">推荐桥梁</p>
                                <p className="font-bold text-gray-900">
                                  {interventionSuggestion.nearestWarmNode.name} ({interventionSuggestion.nearestWarmNode.mbti || '未知'})
                                </p>
                              </div>
                            </div>
                            <p className="text-gray-700">{interventionSuggestion.suggestion}</p>
                          </div>
                        </div>
                      )}
                      
                      {/* 小团体信息 */}
                      {mapToolMode === 'group' && detectedGroups.length > 0 && (
                        <div className="bg-white border border-gray-200 rounded-xl">
                          <div className="p-4 border-b border-gray-200">
                            <h3 className="font-bold text-gray-900">识别到的小团体 ({detectedGroups.length}个)</h3>
                          </div>
                          <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                            {detectedGroups.map((group) => (
                              <div key={group.id} className="bg-gray-50 rounded-lg p-4">
                                <h4 className="font-bold text-gray-800 mb-2">小团体 {group.id + 1}</h4>
                                <p className="text-sm text-gray-600 mb-2">
                                  成员: {group.members.map(m => m.name).join('、')}
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      
                      {/* 桥梁人推荐 */}
                      {mapToolMode === 'bridge' && (
                        <div className="space-y-6">
                          {/* 小团体选择 */}
                          {detectedGroups.length > 0 && (
                            <div className="bg-white border border-gray-200 rounded-xl">
                              <div className="p-4 border-b border-gray-200">
                                <h3 className="font-bold text-gray-900 mb-2">选择小团体（最多选2个）</h3>
                                <p className="text-sm text-gray-600">点击选择两个小团体，系统将计算连接它们的最佳桥梁人</p>
                              </div>
                              <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                                {detectedGroups.map((group) => {
                                  const isSelected = selectedBridgeGroups.some(g => g.id === group.id);
                                  const selectIndex = selectedBridgeGroups.findIndex(g => g.id === group.id);
                                  
                                  return (
                                    <div 
                                      key={group.id}
                                      className={`p-4 rounded-lg cursor-pointer transition-all border-2 ${
                                        isSelected 
                                          ? (selectIndex === 0 ? 'border-blue-500 bg-blue-50' : 'border-red-500 bg-red-50')
                                          : 'border-gray-200 bg-gray-50 hover:border-gray-300'
                                      }`}
                                      onClick={(e) => {
                                        e.stopPropagation(); // 阻止事件冒泡，不影响节点选择
                                        if (isSelected) {
                                          setSelectedBridgeGroups(selectedBridgeGroups.filter(g => g.id !== group.id));
                                        } else if (selectedBridgeGroups.length < 2) {
                                          setSelectedBridgeGroups([...selectedBridgeGroups, group]);
                                        }
                                      }}
                                    >
                                      <div className="flex items-center justify-between mb-2">
                                        <h4 className="font-bold text-gray-800">
                                          小团体 {group.id + 1}
                                          {isSelected && (
                                            <span className={`ml-2 px-2 py-0.5 text-xs rounded-full ${
                                              selectIndex === 0 ? 'bg-blue-500 text-white' : 'bg-red-500 text-white'
                                            }`}>
                                              {selectIndex === 0 ? '团体A' : '团体B'}
                                            </span>
                                          )}
                                        </h4>
                                        <div className={`w-4 h-4 rounded-full border-2 ${
                                          isSelected 
                                            ? (selectIndex === 0 ? 'border-blue-500 bg-blue-500' : 'border-red-500 bg-red-500')
                                            : 'border-gray-300'
                                        }`}>
                                          {isSelected && (
                                            <svg className="w-3 h-3 text-white mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7"></path>
                                            </svg>
                                          )}
                                        </div>
                                      </div>
                                      <p className="text-sm text-gray-600">
                                        成员: {group.members.map(m => m.name).join('、')}
                                      </p>
                                    </div>
                                  );
                                })}
                              </div>
                              {selectedBridgeGroups.length > 0 && (
                                <div className="p-4 border-t border-gray-200 bg-gray-50">
                                  <button
                                    onClick={() => setSelectedBridgeGroups([])}
                                    className="text-sm text-gray-600 hover:text-gray-800"
                                  >
                                    清除选择
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                          
                          {/* 推荐桥梁人 */}
                          {recommendedBridges.length > 0 && (
                            <div className="bg-white border border-gray-200 rounded-xl">
                              <div className="p-4 border-b border-gray-200">
                                <h3 className="font-bold text-gray-900">
                                  {selectedBridgeGroups.length === 2 
                                    ? `连接团体A和团体B的最佳桥梁人` 
                                    : '推荐桥梁人'
                                  }
                                </h3>
                              </div>
                              <div className="divide-y divide-gray-100">
                                {recommendedBridges.map((bridge, index) => {
                                  // 生成角色肯定文案
                                  let affirmationText = '';
                                  if (selectedBridgeGroups.length === 2 && bridge.betweenGroups) {
                                    const traits = [
                                      '社交能力出色',
                                      '善于沟通协调',
                                      '在两个团体中都有良好的人脉',
                                      '是促进团体融合的关键人物',
                                      '能够有效传递信息',
                                      '具备良好的亲和力'
                                    ];
                                    const randomTraits = traits.sort(() => 0.5 - Math.random()).slice(0, 2);
                                    affirmationText = `${bridge.node.name}（${bridge.node.mbti || '未知'}）${randomTraits.join('、')}，是连接这两个团体的绝佳桥梁人选！`;
                                  } else {
                                    affirmationText = `${bridge.node.name}（${bridge.node.mbti || '未知'}）跨群体连接能力强，是促进集体融合的重要人物。`;
                                  }
                                  
                                  return (
                                    <div key={bridge.node.id} className="p-4">
                                      <div className="flex items-center justify-between mb-3">
                                        <div>
                                          <p className="font-bold text-gray-900">
                                            {bridge.node.name} ({bridge.node.mbti || '未知'})
                                          </p>
                                          <p className="text-sm text-gray-600">
                                            总连接: {bridge.totalConnections} | 跨群体连接: {bridge.crossGroupConnections}
                                          </p>
                                        </div>
                                        <span className="px-3 py-1 bg-purple-100 text-purple-700 text-xs rounded-full font-medium">
                                          推荐度 {(bridge.score * 100).toFixed(0)}%
                                        </span>
                                      </div>
                                      <div className="bg-purple-50 border border-purple-200 rounded-lg p-3">
                                        <p className="text-sm text-purple-800">
                                          🌟 {affirmationText}
                                        </p>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                      
                      {/* 孤岛节点列表 */}
                      {mapToolMode === 'focus-island' && detectedIslands.length > 0 && (
                        <div className="bg-white border border-gray-200 rounded-xl">
                          <div className="p-4 border-b border-gray-200">
                            <h3 className="font-bold text-gray-900">检测到的孤岛节点 ({detectedIslands.length}个)</h3>
                          </div>
                          <div className="divide-y divide-gray-100">
                            {detectedIslands.map((node) => (
                              <div 
                              key={node.id}
                              className={`p-4 cursor-pointer hover:bg-gray-50 transition-colors ${
                                selectedMapMemberId === node.id ? 'bg-orange-50' : ''
                              }`}
                              onClick={() => {
                                setSelectedMapMemberId(node.id);
                                generateInterventionSuggestion(node.id);
                              }}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                  <div className="w-3 h-3 rounded-full bg-orange-500"></div>
                                  <div>
                                    <p className="font-bold text-gray-900">
                                      {node.name} ({node.mbti || '未知'})
                                    </p>
                                    <p className="text-sm text-gray-600">
                                      正向提名: {node.positiveCount} | 反向提名: {node.negativeCount}
                                    </p>
                                  </div>
                                </div>
                                <span className="px-2 py-1 bg-orange-100 text-orange-700 text-xs rounded-full font-medium">
                                  孤岛
                                </span>
                              </div>
                            </div>
                            ))}
                          </div>
                        </div>
                      )}
                      
                      {/* 节点数据列表 */}
                      <div className="bg-white border border-gray-200 rounded-xl">
                        <div className="p-4 border-b border-gray-200">
                          <h3 className="font-bold text-gray-900">节点数据</h3>
                        </div>
                        <div className="divide-y divide-gray-100 max-h-[300px] overflow-y-auto">
                          {socialMapData.nodes.map((node) => (
                            <div 
                              key={node.id}
                              className={`p-4 cursor-pointer hover:bg-gray-50 transition-colors ${
                                selectedMapMemberId === node.id ? 'bg-purple-50' : ''
                              }`}
                              onClick={() => setSelectedMapMemberId(node.id)}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                  <div className={`w-3 h-3 rounded-full ${
                                    node.type === 'extrovert' ? 'bg-orange-500' : 'bg-blue-500'
                                  }`}></div>
                                  <div>
                                    <p className="font-medium text-gray-900">
                                      {node.name} ({node.mbti || '未知'})
                                    </p>
                                    <p className="text-sm text-gray-600">
                                      正向提名: {node.positiveCount} | 反向提名: {node.negativeCount}
                                    </p>
                                  </div>
                                </div>
                                {node.alertLevel === 'red' && (
                                  <span className="px-2 py-1 bg-red-100 text-red-700 text-xs rounded-full font-medium">
                                    红码
                                  </span>
                                )}
                                {node.alertLevel === 'yellow' && (
                                  <span className="px-2 py-1 bg-yellow-100 text-yellow-700 text-xs rounded-full font-medium">
                                    黄码
                                  </span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                  
                  {/* 相容性分析 */}
                  {psychologicalStationTab === 'compatibility' && (
                    <div className="space-y-6">
                      {/* 成员选择器 */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-3">成员 A</label>
                          <div className="space-y-2">
                            <select
                              value={compatibilityClassA || ''}
                              onChange={(e) => {
                                setCompatibilityClassA(e.target.value || null);
                                setSelectedMemberA(null);
                                setCompatibilityReport('');
                              }}
                              className="w-full bg-gray-50 border border-gray-200 rounded-lg p-2.5 text-sm"
                            >
                              <option value="">-- 请选择班级 --</option>
                              {classes.map(className => (
                                <option key={className} value={className}>{className}</option>
                              ))}
                            </select>
                            <select
                              value={selectedMemberA || ''}
                              onChange={(e) => {
                                setSelectedMemberA(e.target.value || null);
                                setCompatibilityReport('');
                              }}
                              disabled={!compatibilityClassA}
                              className="w-full bg-gray-50 border border-gray-200 rounded-lg p-2.5 text-sm"
                            >
                              <option value="">-- 请选择成员 --</option>
                              {compatibilityClassA && members
                                .filter(m => m.class === compatibilityClassA)
                                .map(m => (
                                  <option key={m.id} value={m.id}>{m.name} ({m.mbti || '未知'})</option>
                                ))}
                            </select>
                          </div>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-3">成员 B</label>
                          <div className="space-y-2">
                            <select
                              value={compatibilityClassB || ''}
                              onChange={(e) => {
                                setCompatibilityClassB(e.target.value || null);
                                setSelectedMemberB(null);
                                setCompatibilityReport('');
                              }}
                              className="w-full bg-gray-50 border border-gray-200 rounded-lg p-2.5 text-sm"
                            >
                              <option value="">-- 请选择班级 --</option>
                              {classes.map(className => (
                                <option key={className} value={className}>{className}</option>
                              ))}
                            </select>
                            <select
                              value={selectedMemberB || ''}
                              onChange={(e) => {
                                setSelectedMemberB(e.target.value || null);
                                setCompatibilityReport('');
                              }}
                              disabled={!compatibilityClassB}
                              className="w-full bg-gray-50 border border-gray-200 rounded-lg p-2.5 text-sm"
                            >
                              <option value="">-- 请选择成员 --</option>
                              {compatibilityClassB && members
                                .filter(m => m.class === compatibilityClassB)
                                .map(m => (
                                  <option key={m.id} value={m.id}>{m.name} ({m.mbti || '未知'})</option>
                                ))}
                            </select>
                          </div>
                        </div>
                      </div>
                      
                      <button
                        onClick={() => {
                          if (selectedMemberA && selectedMemberB) {
                            fetchCompatibility(selectedMemberA, selectedMemberB);
                          }
                        }}
                        disabled={!selectedMemberA || !selectedMemberB || isCompatibilityLoading}
                        className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isCompatibilityLoading ? '正在分析...' : '分析相容性'}
                      </button>

                      {compatibilityError && (
                        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
                          {compatibilityError}
                        </div>
                      )}
                      
                      {/* 流式分析结果 */}
                      {(isCompatibilityLoading || compatibilityReport) && (
                        <div 
                          ref={compatibilityRef}
                          onScroll={() => {
                            if (compatibilityRef.current) {
                              const { scrollTop, scrollHeight, clientHeight } = compatibilityRef.current;
                              const isAtBottom = scrollTop + clientHeight >= scrollHeight - 10;
                              compatibilityAutoScroll.current = isAtBottom;
                            }
                          }}
                          className="bg-white border border-gray-200 rounded-xl p-6 max-h-[600px] overflow-y-auto"
                        >
                          <h3 className="font-bold text-lg text-gray-900 mb-4">📊 相容性分析报告</h3>
                          
                          {!isCompatibilityLoading && !compatibilityReport && (
                            <p className="text-gray-500 text-sm">等待生成报告...</p>
                          )}
                          
                          {compatibilityReport && (
                            <div 
                              className="prose prose-sm max-w-none markdown-content"
                              dangerouslySetInnerHTML={{ __html: formatMarkdown(compatibilityReport) }}
                            />
                          )}
                          
                          {isCompatibilityLoading && (
                            <div className="flex items-center gap-2 text-purple-600 mt-4">
                              <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                              </svg>
                              <span>AI 正在分析中...</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  
                  {/* 心理咨询 */}
                  {psychologicalStationTab === 'counseling' && (
                    <div className="space-y-6">
                      <div className="bg-gradient-to-r from-indigo-500 to-purple-600 rounded-xl p-6 text-white">
                        <h3 className="text-xl font-bold mb-2">🧠 AI 心理咨询</h3>
                        <p className="text-sm opacity-90">基于成员的多维度数据，AI将生成专业的心理咨询报告和干预建议</p>
                      </div>

                      {!isCounselingLoading && !counselingReport && (
                        <div className="space-y-4">
                          {/* 选择咨询对象 */}
                          <div className="bg-white border border-gray-200 rounded-xl p-4">
                            <label className="block text-sm font-bold text-gray-700 mb-3">
                              📌 选择咨询对象
                            </label>
                            <div className="grid grid-cols-2 gap-4">
                              <div>
                                <label className="block text-xs text-gray-500 mb-1">班级</label>
                                <select
                                  value={counselingClass || ''}
                                  onChange={(e) => {
                                    setCounselingClass(e.target.value || null);
                                    setCounselingMemberId(null);
                                    setCounselingReport('');
                                    setCounselingError(null);
                                  }}
                                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                                >
                                  <option value="">-- 请选择班级 --</option>
                                  {classes.map(className => (
                                    <option key={className} value={className}>
                                      {className}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label className="block text-xs text-gray-500 mb-1">成员</label>
                                <select
                                  value={counselingMemberId || ''}
                                  onChange={(e) => {
                                    setCounselingMemberId(e.target.value || null);
                                    setCounselingReport('');
                                    setCounselingError(null);
                                  }}
                                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                                  disabled={!counselingClass}
                                >
                                  <option value="">-- 请选择成员 --</option>
                                  {counselingClass && members
                                    .filter(m => m.class === counselingClass)
                                    .map(member => (
                                      <option key={member.id} value={member.id}>
                                        {member.name} {member.mbti ? `(${member.mbti})` : ''}
                                      </option>
                                    ))}
                                </select>
                              </div>
                            </div>
                          </div>

                          {/* 补充说明 */}
                          <div className="bg-white border border-gray-200 rounded-xl p-4">
                            <label className="block text-sm font-bold text-gray-700 mb-3">
                              ✏️ 补充说明（可选）
                            </label>
                            <textarea
                              value={counselingNotes}
                              onChange={(e) => setCounselingNotes(e.target.value)}
                              placeholder="例如：重点关注社交关系方面、近期情绪波动明显、学习压力较大等..."
                              className="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
                              rows="4"
                            />
                            <p className="text-xs text-gray-400 mt-2">填写后AI将在报告中重点分析这些方面</p>
                          </div>

                          {/* 生成报告按钮 */}
                          <button
                            onClick={() => {
                              if (!counselingMemberId) {
                                showNotification('请先选择咨询对象');
                                return;
                              }
                              generateCounselingReport();
                            }}
                            disabled={!counselingMemberId}
                            className={`w-full py-4 rounded-xl font-bold text-white transition-all ${
                              counselingMemberId
                                ? 'bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 shadow-lg hover:shadow-xl'
                                : 'bg-gray-300 cursor-not-allowed'
                            }`}
                          >
                            <span className="flex items-center justify-center gap-2">
                              <Brain size={20} />
                              生成心理咨询报告
                            </span>
                          </button>
                        </div>
                      )}

                      {/* 加载状态 */}
                      {isCounselingLoading && (
                        <div className="space-y-4">
                          <div className="bg-white border border-gray-200 rounded-xl p-4">
                            <div className="flex items-center gap-3 mb-4">
                              <div className="w-8 h-8 bg-purple-100 rounded-full flex items-center justify-center">
                                <Brain size={18} className="text-purple-600 animate-pulse" />
                              </div>
                              <div>
                                <p className="font-bold text-gray-900">正在分析...</p>
                                <p className="text-xs text-gray-500">AI 正在综合分析数据并生成报告</p>
                              </div>
                            </div>
                            
                            {/* 流式输出区域 */}
                            <div 
                              ref={counselingRef}
                              className="bg-gray-50 rounded-lg p-4 max-h-[60vh] overflow-y-auto prose prose-sm max-w-none"
                              onScroll={(e) => {
                                const { scrollTop, scrollHeight, clientHeight } = e.target;
                                const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
                                counselingAutoScroll.current = isAtBottom;
                              }}
                            >
                              {counselingReport && (
                                <div dangerouslySetInnerHTML={{ __html: formatMarkdown(counselingReport) }} />
                              )}
                              {!counselingReport && (
                                <div className="flex items-center gap-2 text-gray-400">
                                  <div className="w-2 h-2 bg-purple-500 rounded-full animate-bounce"></div>
                                  <div className="w-2 h-2 bg-purple-500 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                                  <div className="w-2 h-2 bg-purple-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                                  <span className="ml-2 text-sm">等待AI响应...</span>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* 停止按钮 */}
                          <button
                            onClick={() => {
                              setIsCounselingLoading(false);
                              setCounselingError('已停止生成');
                            }}
                            className="w-full py-3 bg-red-50 text-red-600 rounded-xl font-medium hover:bg-red-100 transition-colors"
                          >
                            停止生成
                          </button>
                        </div>
                      )}

                      {/* 报告显示 */}
                      {!isCounselingLoading && counselingReport && (
                        <div className="space-y-4">
                          <div className="bg-white border border-gray-200 rounded-xl p-4">
                            <div className="flex items-center justify-between mb-4">
                              <div className="flex items-center gap-3">
                                <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
                                  <CheckCircle2 size={20} className="text-green-600" />
                                </div>
                                <div>
                                  <p className="font-bold text-gray-900">分析完成</p>
                                  <p className="text-xs text-gray-500">心理咨询报告已生成</p>
                                </div>
                              </div>
                              <div className="flex gap-2">
                                <button
                                  onClick={() => {
                                    navigator.clipboard.writeText(counselingReport).then(() => {
                                      showNotification('已复制到剪贴板！');
                                    });
                                  }}
                                  className="px-4 py-2 bg-purple-50 text-purple-600 rounded-lg text-sm font-medium hover:bg-purple-100 transition-colors"
                                >
                                  复制报告
                                </button>
                                <button
                                  onClick={() => {
                                    setCounselingReport('');
                                    setCounselingNotes('');
                                  }}
                                  className="px-4 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm font-medium hover:bg-gray-200 transition-colors"
                                >
                                  重新分析
                                </button>
                              </div>
                            </div>
                            
                            {/* 报告内容 */}
                            <div 
                              ref={followUpRef}
                              className="bg-gray-50 rounded-lg p-6 max-h-[60vh] overflow-y-auto prose prose-sm max-w-none"
                            >
                              <div dangerouslySetInnerHTML={{ __html: formatMarkdown(counselingReport) }} />
                            </div>
                            
                            {/* 追加提问区域 */}
                            {(!isCounselingLoading && counselingReport) && (
                              <div className="mt-4 pt-4 border-t border-gray-200">
                                <p className="text-sm font-medium text-gray-700 mb-2">💬 追加提问</p>
                                <div className="flex gap-2">
                                  <input
                                    type="text"
                                    value={followUpQuestion}
                                    onChange={(e) => setFollowUpQuestion(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' && !isFollowUpLoading) {
                                        sendFollowUpQuestion();
                                      }
                                    }}
                                    placeholder="输入您想进一步了解的问题..."
                                    disabled={isFollowUpLoading}
                                    className="flex-1 px-4 py-2.5 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent disabled:opacity-50"
                                  />
                                  <button
                                    onClick={sendFollowUpQuestion}
                                    disabled={!followUpQuestion.trim() || isFollowUpLoading}
                                    className="px-5 py-2.5 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                                  >
                                    {isFollowUpLoading ? (
                                      <>
                                        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                        </svg>
                                        发送中
                                      </>
                                    ) : '发送'}
                                  </button>
                                </div>
                                {followUpError && (
                                  <p className="mt-2 text-xs text-red-600">{followUpError}</p>
                                )}
                                {conversationHistory.length > 0 && (
                                  <p className="mt-2 text-xs text-gray-400">已进行 {Math.floor(conversationHistory.length / 2)} 轮对话</p>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* 错误提示 */}
                      {counselingError && !isCounselingLoading && !counselingReport && (
                        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                          <div className="flex items-center gap-3">
                            <AlertTriangle size={20} className="text-red-500" />
                            <div>
                              <p className="font-medium text-red-800">生成失败</p>
                              <p className="text-sm text-red-600">{counselingError}</p>
                            </div>
                          </div>
                          <button
                            onClick={() => {
                              setCounselingError(null);
                              generateCounselingReport();
                            }}
                            className="mt-3 px-4 py-2 bg-red-100 text-red-700 rounded-lg text-sm font-medium hover:bg-red-200 transition-colors"
                          >
                            重试
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
            
            {/* 免责声明 */}
            <div className="p-4 border-t border-gray-200 bg-gray-50">
              <p className="text-xs text-gray-400 text-center">
                数据逻辑辅助观察，不作为心理诊断依据。
              </p>
            </div>
          </div>
        </div>
      )}
      {/* 周总结弹窗 */}
      {showWeekSummaryModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200 bg-gradient-to-r from-pink-500 to-pink-600">
              <h2 className="text-xl font-bold text-white">周总结</h2>
              <button
                onClick={() => setShowWeekSummaryModal(false)}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6">
              {/* 周次选择 */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">选择周次</label>
                <div className="flex gap-3 items-center">
                  <select
                    value={selectedSummaryWeek || ''}
                    onChange={async (e) => {
                      const week = parseInt(e.target.value);
                      setSelectedSummaryWeek(week);
                      await fetchWeekSummary(week);
                    }}
                    className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-pink-500"
                  >
                    <option value="">请选择周次</option>
                    {availableWeeks.map(week => (
                      <option key={week} value={week}>第{week}周</option>
                    ))}
                  </select>
                </div>
              </div>
              
              {/* 加载状态 */}
              {loadingWeekSummary && (
                <div className="flex items-center justify-center py-12">
                  <div className="w-12 h-12 border-4 border-pink-200 border-t-pink-600 rounded-full animate-spin"></div>
                </div>
              )}
              
              {/* 周总结内容 */}
              {!loadingWeekSummary && weekSummaryData && selectedSummaryWeek && (
                <div className="space-y-6">
                  {/* 日期范围 */}
                  {weekSummaryData.dateRange && (
                    <div className="p-4 bg-pink-50 border border-pink-200 rounded-xl">
                      <h3 className="text-lg font-bold text-pink-700 mb-2">
                        第{selectedSummaryWeek}周
                      </h3>
                      <p className="text-sm text-gray-600">
                        {weekSummaryData.dateRange.start} 至 {weekSummaryData.dateRange.end}
                      </p>
                    </div>
                  )}
                  
                  {/* 评分统计 */}
                  {weekSummaryData.scoreStats && (
                    <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl">
                      <h3 className="text-lg font-bold text-blue-700 mb-4">评分概况</h3>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div className="p-3 bg-white rounded-lg">
                          <p className="text-xs text-gray-500 mb-1">总评分人次</p>
                          <p className="text-2xl font-bold text-blue-600">{weekSummaryData.scoreStats.totalScores}</p>
                        </div>
                        <div className="p-3 bg-white rounded-lg">
                          <p className="text-xs text-gray-500 mb-1">总体平均分</p>
                          <p className="text-2xl font-bold text-blue-600">{weekSummaryData.scoreStats.overallAverage?.toFixed(1) || '-'}</p>
                        </div>
                        <div className="p-3 bg-white rounded-lg">
                          <p className="text-xs text-gray-500 mb-1">已评分人数</p>
                          <p className="text-2xl font-bold text-green-600">{weekSummaryData.scoreStats.scoredMembers}</p>
                        </div>
                        <div className="p-3 bg-white rounded-lg">
                          <p className="text-xs text-gray-500 mb-1">未完成评分人数</p>
                          <p className="text-2xl font-bold text-red-600">{weekSummaryData.scoreStats.incompleteCount}</p>
                        </div>
                      </div>
                      {/* 未完成评分的人列表 */}
                      {weekSummaryData.scoreStats.incompleteList && weekSummaryData.scoreStats.incompleteList.length > 0 && (
                        <div className="mt-4">
                          <h4 className="text-sm font-medium text-gray-700 mb-2">未完成评分的人名单</h4>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            {weekSummaryData.scoreStats.incompleteList.map((item, idx) => (
                              <div key={idx} className="p-2 bg-white rounded text-sm">
                                <span className="font-medium text-gray-800">{item.evaluatorName}</span>
                                <span className="text-gray-500 ml-1">({item.className})</span>
                                <span className="text-red-600 font-bold ml-2">
                                  已评{item.ratedCount}/{item.totalCount}人
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {/* 各维度平均分 */}
                      {weekSummaryData.scoreStats.dimensionAverages && (
                        <div className="mt-4">
                          <h4 className="text-sm font-medium text-gray-700 mb-2">各维度平均分</h4>
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                            {Object.entries(weekSummaryData.scoreStats.dimensionAverages).map(([key, value]) => {
                              const dim = dimensions.find(d => d.key === key);
                              return (
                                <div key={key} className="p-2 bg-white rounded text-center">
                                  <p className="text-xs text-gray-500">{dim?.label || key}</p>
                                  <p className="font-bold text-blue-600">{value?.toFixed(1) || '-'}</p>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  
                  {/* 通报统计 */}
                  {weekSummaryData.noticeStats && (
                    <div className="p-4 bg-red-50 border border-red-200 rounded-xl">
                      <h3 className="text-lg font-bold text-red-700 mb-4">通报情况</h3>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="p-3 bg-white rounded-lg">
                          <p className="text-xs text-gray-500 mb-1">通报总次数</p>
                          <p className="text-2xl font-bold text-red-600">{weekSummaryData.noticeStats.totalNotices}</p>
                        </div>
                        <div className="p-3 bg-white rounded-lg">
                          <p className="text-xs text-gray-500 mb-1">涉及人数</p>
                          <p className="text-2xl font-bold text-red-600">{weekSummaryData.noticeStats.involvedMembers}</p>
                        </div>
                      </div>
                      {/* 通报名单 */}
                      {weekSummaryData.noticeStats.noticeList && weekSummaryData.noticeStats.noticeList.length > 0 && (
                        <div className="mt-4">
                          <h4 className="text-sm font-medium text-gray-700 mb-2">通报名单</h4>
                          <div className="space-y-2">
                            {weekSummaryData.noticeStats.noticeList.map((notice, idx) => (
                              <div key={idx} className="p-2 bg-white rounded text-sm">
                                <span className="font-medium text-gray-800">{maskName(notice.memberName)}</span>
                                <span className="text-gray-500 ml-2">({maskClassName(notice.className)})</span>
                                <p className="text-gray-600 text-xs mt-1">{notice.content}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  
                  {/* BMI统计 */}
                  {weekSummaryData.bmiStats && (
                    <div className="p-4 bg-teal-50 border border-teal-200 rounded-xl">
                      <h3 className="text-lg font-bold text-teal-700 mb-4">BMI情况</h3>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div className="p-3 bg-white rounded-lg">
                          <p className="text-xs text-gray-500 mb-1">有数据人数</p>
                          <p className="text-2xl font-bold text-teal-600">{weekSummaryData.bmiStats.totalMembers}</p>
                        </div>
                        <div className="p-3 bg-white rounded-lg">
                          <p className="text-xs text-gray-500 mb-1">总体平均BMI</p>
                          <p className="text-2xl font-bold text-teal-600">{weekSummaryData.bmiStats.overallAverage?.toFixed(1) || '-'}</p>
                        </div>
                        <div className="p-3 bg-white rounded-lg">
                          <p className="text-xs text-gray-500 mb-1">及格人数</p>
                          <p className="text-2xl font-bold text-green-600">{weekSummaryData.bmiStats.passCount}</p>
                        </div>
                        <div className="p-3 bg-white rounded-lg">
                          <p className="text-xs text-gray-500 mb-1">不及格人数</p>
                          <p className="text-2xl font-bold text-red-600">{weekSummaryData.bmiStats.failCount}</p>
                        </div>
                      </div>
                      {/* 不及格名单 */}
                      {weekSummaryData.bmiStats.failList && weekSummaryData.bmiStats.failList.length > 0 && (
                        <div className="mt-4">
                          <h4 className="text-sm font-medium text-gray-700 mb-2">不及格名单</h4>
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                            {weekSummaryData.bmiStats.failList.map((item, idx) => (
                              <div key={idx} className="p-2 bg-white rounded text-sm">
                                <span className="font-medium text-gray-800">{item.memberName}</span>
                                <span className="text-gray-500 ml-1">({item.className})</span>
                                <span className="text-red-600 font-bold ml-2">{item.bmi?.toFixed(1)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  
                  {/* 伤病统计 */}
                  {weekSummaryData.injuryStats && (
                    <div className="p-4 bg-orange-50 border border-orange-200 rounded-xl">
                      <h3 className="text-lg font-bold text-orange-700 mb-4">伤病情况</h3>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="p-3 bg-white rounded-lg">
                          <p className="text-xs text-gray-500 mb-1">伤病人数</p>
                          <p className="text-2xl font-bold text-orange-600">{weekSummaryData.injuryStats.injuryCount}</p>
                        </div>
                      </div>
                      {/* 伤病名单 */}
                      {weekSummaryData.injuryStats.injuryList && weekSummaryData.injuryStats.injuryList.length > 0 && (
                        <div className="mt-4">
                          <h4 className="text-sm font-medium text-gray-700 mb-2">伤病名单</h4>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                            {weekSummaryData.injuryStats.injuryList.map((item, idx) => (
                              <div key={idx} className="p-2 bg-white rounded text-sm">
                                <span className="font-medium text-gray-800">{item.memberName}</span>
                                <span className="text-gray-500 ml-2">({item.className})</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  
                  {/* 亮点 */}
                  {weekSummaryData.highlights && (
                    <div className="p-4 bg-green-50 border border-green-200 rounded-xl">
                      <h3 className="text-lg font-bold text-green-700 mb-4">亮点</h3>
                      
                      {/* 综合分最高的5名个人 */}
                      {weekSummaryData.highlights.topScorers && weekSummaryData.highlights.topScorers.length > 0 && (
                        <div className="mb-4">
                          <h4 className="text-sm font-medium text-gray-700 mb-2">综合分最高的5名个人</h4>
                          <div className="space-y-2">
                            {weekSummaryData.highlights.topScorers.map((item, idx) => (
                              <div key={idx} className="p-2 bg-white rounded text-sm flex justify-between items-center">
                                <div>
                                  <span className="font-bold text-green-700 mr-2">第{idx + 1}名</span>
                                  <span className="font-medium text-gray-800">{item.memberName}</span>
                                  <span className="text-gray-500 ml-1">({item.className})</span>
                                </div>
                                <span className="font-bold text-green-600">{item.score?.toFixed(1)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      
                      {/* 进步最大的5名个人 */}
                      {weekSummaryData.highlights.mostImproved && weekSummaryData.highlights.mostImproved.length > 0 && (
                        <div>
                          <h4 className="text-sm font-medium text-gray-700 mb-2">进步最大的5名个人</h4>
                          <div className="space-y-2">
                            {weekSummaryData.highlights.mostImproved.map((item, idx) => (
                              <div key={idx} className="p-2 bg-white rounded text-sm flex justify-between items-center">
                                <div>
                                  <span className="font-bold text-green-700 mr-2">第{idx + 1}名</span>
                                  <span className="font-medium text-gray-800">{item.memberName}</span>
                                  <span className="text-gray-500 ml-1">({item.className})</span>
                                </div>
                                <div className="text-right">
                                  <span className="font-bold text-green-600">+{item.improvement?.toFixed(1)}</span>
                                  <span className="text-gray-400 text-xs ml-1">({item.prevScore?.toFixed(1)} → {item.currentScore?.toFixed(1)})</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      
                      {(!weekSummaryData.highlights.topScorers || weekSummaryData.highlights.topScorers.length === 0) && 
                       (!weekSummaryData.highlights.mostImproved || weekSummaryData.highlights.mostImproved.length === 0) && (
                        <div className="text-center py-4 text-gray-500">
                          暂无亮点数据
                        </div>
                      )}
                    </div>
                  )}
                  
                  {/* 不足 */}
                  {weekSummaryData.weaknesses && (
                    <div className="p-4 bg-red-50 border border-red-200 rounded-xl">
                      <h3 className="text-lg font-bold text-red-700 mb-4">不足</h3>
                      
                      {/* 需要重点关注的5名个人 */}
                      {weekSummaryData.weaknesses.needAttention && weekSummaryData.weaknesses.needAttention.length > 0 && (
                        <div>
                          <h4 className="text-sm font-medium text-gray-700 mb-2">需要重点关注的5名个人</h4>
                          <div className="space-y-2">
                            {weekSummaryData.weaknesses.needAttention.map((item, idx) => (
                              <div key={idx} className="p-2 bg-white rounded text-sm flex justify-between items-center">
                                <div>
                                  <span className="font-bold text-red-700 mr-2">第{idx + 1}名</span>
                                  <span className="font-medium text-gray-800">{item.memberName}</span>
                                  <span className="text-gray-500 ml-1">({item.className})</span>
                                </div>
                                <span className="font-bold text-red-600">{item.score?.toFixed(1)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      
                      {(!weekSummaryData.weaknesses.needAttention || weekSummaryData.weaknesses.needAttention.length === 0) && (
                        <div className="text-center py-4 text-gray-500">
                          暂无需要重点关注的人员
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              
              {/* 未选择周次或无数据 */}
              {!loadingWeekSummary && !weekSummaryData && selectedSummaryWeek && (
                <div className="text-center py-12 text-gray-500">
                  该周暂无总结数据
                </div>
              )}
              
              {!loadingWeekSummary && !selectedSummaryWeek && (
                <div className="text-center py-12 text-gray-500">
                  请选择周次查看总结
                </div>
              )}
            </div>
            
            <div className="p-6 border-t border-gray-200">
              <button
                onClick={() => setShowWeekSummaryModal(false)}
                className="w-full px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors font-medium"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 编辑公告 Modal */}
      {showEditNoticeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 className="text-xl font-bold text-gray-900">修改更新公告</h2>
              <button
                onClick={() => {
                  setShowEditNoticeModal(false);
                  setEditNoticeForm({ updateNotice: '', downloadLink: '', contact: '' });
                }}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">更新公告内容</label>
                <textarea
                  value={editNoticeForm.updateNotice}
                  onChange={(e) => setEditNoticeForm({ ...editNoticeForm, updateNotice: e.target.value })}
                  placeholder="请输入更新公告内容，每行一条"
                  rows={8}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">下载链接</label>
                <input
                  type="text"
                  value={editNoticeForm.downloadLink}
                  onChange={(e) => setEditNoticeForm({ ...editNoticeForm, downloadLink: e.target.value })}
                  placeholder="请输入下载链接"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">联系方式</label>
                <input
                  type="text"
                  value={editNoticeForm.contact}
                  onChange={(e) => setEditNoticeForm({ ...editNoticeForm, contact: e.target.value })}
                  placeholder="请输入联系方式"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>
              <div className="flex gap-3 pt-4">
                <button
                  onClick={() => {
                    setShowEditNoticeModal(false);
                    setEditNoticeForm({ updateNotice: '', downloadLink: '', contact: '' });
                  }}
                  className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors font-medium"
                >
                  取消
                </button>
                <button
                  onClick={() => {
                    saveUpdateNotices(
                      editNoticeForm.updateNotice,
                      editNoticeForm.downloadLink,
                      editNoticeForm.contact
                    );
                  }}
                  className="flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-medium"
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 评分警告确认弹窗 */}
      {showScoreWarningModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 className="text-xl font-bold text-gray-900">评分异常警告</h2>
              <button
                onClick={() => {
                  setShowScoreWarningModal(false);
                  setPendingSubmit(false);
                }}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-gray-600">检测到以下评分异常，请确认是否继续提交：</p>
              <div className="space-y-3">
                {scoreWarnings.map((warning, index) => (
                  <div
                    key={index}
                    className={`flex items-start gap-2 p-3 rounded-lg ${
                      warning.severity === 'high'
                        ? 'bg-red-50 border border-red-200'
                        : warning.severity === 'medium'
                        ? 'bg-yellow-50 border border-yellow-200'
                        : 'bg-blue-50 border border-blue-200'
                    }`}
                  >
                    {warning.severity === 'high' ? (
                      <AlertTriangle size={20} className="text-red-500 flex-shrink-0 mt-0.5" />
                    ) : warning.severity === 'medium' ? (
                      <AlertTriangle size={20} className="text-yellow-500 flex-shrink-0 mt-0.5" />
                    ) : (
                      <svg className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    )}
                    <p className={`text-sm ${
                      warning.severity === 'high'
                        ? 'text-red-800'
                        : warning.severity === 'medium'
                        ? 'text-yellow-800'
                        : 'text-blue-800'
                    }`}>
                      {warning.message}
                    </p>
                  </div>
                ))}
              </div>
              <div className="flex gap-3 pt-4">
                <button
                  onClick={() => {
                    setShowScoreWarningModal(false);
                    setPendingSubmit(false);
                  }}
                  className="flex-1 px-4 py-3 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors font-medium"
                >
                  重新评分
                </button>
                <button
                  onClick={async () => {
                    setShowScoreWarningModal(false);
                    setPendingSubmit(false);
                    await doSubmitScore();
                  }}
                  className="flex-1 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
                >
                  确认提交
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 辅助填写介绍弹窗（仅第一次进入评分页面时显示） */}
      {showAssistIntroModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 className="text-xl font-bold text-gray-900">辅助填写功能介绍</h2>
              <button
                onClick={() => {
                  setShowAssistIntroModal(false);
                  localStorage.setItem('hasSeenAssistIntro', 'true');
                }}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-blue-50 rounded-lg p-4">
                <h3 className="font-bold text-blue-800 mb-2">💡 功能说明</h3>
                <p className="text-gray-700 text-sm leading-relaxed">
                  开启辅助填写模式后，系统会自动填充您上周对该成员的评分，您只需要根据本周实际情况进行微调即可。
                </p>
              </div>
              
              <div className="bg-yellow-50 rounded-lg p-4">
                <h3 className="font-bold text-yellow-800 mb-2">⚠️ 注意事项</h3>
                <ul className="text-gray-700 text-sm leading-relaxed space-y-2">
                  <li>• 评分必须与上周有所不同（完全相同将无法提交）</li>
                  <li>• 剧烈波动（超过±2分）的评分需要二次确认</li>
                  <li>• 全部最高分或全部最低分将被视为异常评分</li>
                  <li>• 请根据成员的本周实际表现客观评分</li>
                </ul>
              </div>
              
              <div className="bg-green-50 rounded-lg p-4">
                <h3 className="font-bold text-green-800 mb-2">✅ 优势</h3>
                <ul className="text-gray-700 text-sm leading-relaxed space-y-1">
                  <li>• 简化评分流程，无需从零开始</li>
                  <li>• 保持评分连贯性，避免大幅度波动</li>
                  <li>• 异常检测防止误评和恶评</li>
                </ul>
              </div>
              
              <div className="flex gap-3 pt-4">
                <button
                  onClick={() => {
                    setShowAssistIntroModal(false);
                    localStorage.setItem('hasSeenAssistIntro', 'true');
                  }}
                  className="flex-1 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
                >
                  我知道了
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 补评管理弹窗 */}
      {showMakeupModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200 bg-gradient-to-r from-amber-500 to-orange-600">
              <h2 className="text-xl font-bold text-white">补评管理</h2>
              <button
                onClick={() => setShowMakeupModal(false)}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* 添加新补评 */}
              <div className="bg-gray-50 rounded-xl p-5 space-y-4">
                <h3 className="font-bold text-gray-900 text-lg">添加补评周期</h3>
                
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">补评周次</label>
                      <select
                        value={newMakeupWeek}
                        onChange={(e) => setNewMakeupWeek(parseInt(e.target.value))}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        {Array.from({ length: Math.max(config.currentWeek, 1) }, (_, i) => i + 1).map(w => (
                          <option key={w} value={w}>
                            第{w}周{w === config.currentWeek ? '（当前周）' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">截止时间</label>
                      <input
                        type="datetime-local"
                        value={newMakeupEndTime}
                        onChange={(e) => setNewMakeupEndTime(e.target.value)}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">备注（可选）</label>
                    <input
                      type="text"
                      value={newMakeupDescription}
                      onChange={(e) => setNewMakeupDescription(e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="补评说明或备注"
                    />
                  </div>
                  
                  <button
                    onClick={addMakeupPeriod}
                    className="w-full px-4 py-3 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors font-medium flex items-center justify-center gap-2"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                    </svg>
                    添加补评
                  </button>
                </div>
              </div>
              
              {/* 现有补评列表 */}
              <div className="space-y-4">
                <h3 className="font-bold text-gray-900 text-lg">现有补评周期</h3>
                
                {makeupPeriods.length === 0 ? (
                  <div className="text-center py-10 bg-gray-50 rounded-xl">
                    <Clock size={40} className="mx-auto text-gray-400 mb-3" />
                    <p className="text-gray-500">暂无开放的补评周期</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {makeupPeriods.map((period) => {
                      const isActive = new Date(period.endTime) > new Date();
                      return (
                        <div
                          key={period.id}
                          className={`border rounded-xl p-4 ${isActive ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-gray-50'}`}
                        >
                          <div className="flex items-start justify-between">
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <span className="font-bold text-gray-900 text-lg">第{period.week}周</span>
                                {isActive ? (
                                  <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs font-medium">进行中</span>
                                ) : (
                                  <span className="px-2 py-0.5 bg-gray-200 text-gray-600 rounded-full text-xs font-medium">已结束</span>
                                )}
                              </div>
                              
                              {period.description && (
                                <p className="text-sm text-gray-600">{period.description}</p>
                              )}
                              
                              <p className="text-sm text-gray-500">
                                截止时间：{new Date(period.endTime).toLocaleString('zh-CN')}
                              </p>
                            </div>
                            
                            <button
                              onClick={() => {
                                if (confirm('确定删除这个补评周期吗？')) {
                                  deleteMakeupPeriod(period.id);
                                }
                              }}
                              className="text-red-500 hover:text-red-700 transition-colors p-1"
                            >
                              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {/* 班级管理弹窗 */}
      {showClassManagementModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200 bg-gradient-to-r from-cyan-500 to-blue-600">
              <h2 className="text-xl font-bold text-white">班级管理</h2>
              <button
                onClick={() => setShowClassManagementModal(false)}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* 选择班级 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">选择班级</label>
                <select
                  value={selectedClassForManagement?.name || ''}
                  onChange={async (e) => {
                    const className = e.target.value;
                    if (className) {
                      const selected = classList.find(c => c.name === className);
                      setSelectedClassForManagement(selected);
                      await fetchClassMembers(className);
                      setSelectedNewMonitor(null);
                    } else {
                      setSelectedClassForManagement(null);
                      setClassMembers([]);
                      setSelectedNewMonitor(null);
                    }
                  }}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                >
                  <option value="">请选择班级</option>
                  {classList.map(cls => (
                    <option key={cls.name} value={cls.name}>
                      {cls.name} - 班长：{cls.monitor?.name || '暂无'}（{cls.memberCount}人）
                    </option>
                  ))}
                </select>
              </div>
              
              {/* 班级信息 */}
              {selectedClassForManagement && (
                <div className="bg-cyan-50 border border-cyan-200 rounded-xl p-4">
                  <h3 className="font-bold text-cyan-800 mb-2">当前班级信息</h3>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-gray-600">班级名称：</span>
                      <span className="font-medium text-gray-900">{selectedClassForManagement.name}</span>
                    </div>
                    <div>
                      <span className="text-gray-600">班级人数：</span>
                      <span className="font-medium text-gray-900">{selectedClassForManagement.memberCount}人</span>
                    </div>
                    <div>
                      <span className="text-gray-600">现任班长：</span>
                      <span className="font-medium text-gray-900">{selectedClassForManagement.monitor?.name || '暂无'}</span>
                    </div>
                  </div>
                </div>
              )}
              
              {/* 选择新班长 */}
              {selectedClassForManagement && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    选择新班长
                    {selectedClassForManagement.monitor && (
                      <span className="text-orange-600 text-xs ml-2">（将从{selectedClassForManagement.monitor.name}更换）</span>
                    )}
                  </label>
                  
                  {loadingClassMembers ? (
                    <div className="flex items-center justify-center py-8">
                      <div className="w-8 h-8 border-4 border-cyan-200 border-t-cyan-600 rounded-full animate-spin"></div>
                    </div>
                  ) : (
                    <div className="border border-gray-300 rounded-lg max-h-60 overflow-y-auto">
                      {classMembers.length === 0 ? (
                        <div className="text-center py-8 text-gray-500">暂无班级成员</div>
                      ) : (
                        classMembers.map(member => (
                          <div
                            key={member.id}
                            onClick={() => setSelectedNewMonitor(member)}
                            className={`p-3 cursor-pointer border-b border-gray-200 last:border-b-0 transition-colors ${
                              selectedNewMonitor?.id === member.id
                                ? 'bg-cyan-50 border-l-4 border-l-cyan-600'
                                : 'hover:bg-gray-50'
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <div>
                                <span className="font-medium text-gray-900">{member.name}</span>
                                {member.id === selectedClassForManagement.monitor?.id && (
                                  <span className="ml-2 px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">现任班长</span>
                                )}
                              </div>
                              {member.isBackbone && member.position !== '班长' && (
                                <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs">
                                  {member.position || '骨干'}
                                </span>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
              
              {/* 管理密码 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">管理密码</label>
                <input
                  type="password"
                  value={classManagementPassword}
                  onChange={(e) => setClassManagementPassword(e.target.value)}
                  placeholder="请输入管理密码"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                />
              </div>
              
              {/* 提示信息 */}
              {selectedNewMonitor && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4">
                  <h4 className="font-bold text-yellow-800 mb-2">⚠️ 确认修改</h4>
                  <ul className="text-sm text-gray-700 space-y-1">
                    <li>• 新班长：<span className="font-medium">{selectedNewMonitor.name}</span></li>
                    <li>• 班级名称将更改为：<span className="font-medium">{selectedNewMonitor.name}班</span></li>
                    {selectedClassForManagement?.monitor && (
                      <>
                        <li>• 原班长 <span className="font-medium">{selectedClassForManagement.monitor.name}</span> 将取消班长身份</li>
                        <li>• 原班级名称 <span className="font-medium">{selectedClassForManagement.name}</span> 将不再存在</li>
                      </>
                    )}
                  </ul>
                </div>
              )}
            </div>
            
            <div className="p-6 border-t border-gray-200 flex gap-3">
              <button
                onClick={() => setShowClassManagementModal(false)}
                className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors font-medium"
              >
                取消
              </button>
              <button
                onClick={handleSetMonitor}
                disabled={!selectedClassForManagement || !selectedNewMonitor || !classManagementPassword}
                className="flex-1 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors font-medium disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                确认修改
              </button>
            </div>
          </div>
        </div>
      )}
      {showDailyCheckin && (
        <DailyCheckinModal memberId={currentUser?.id} memberName={currentUser?.name || '学员'} isAdmin={isAdmin} onClose={() => setShowDailyCheckin(false)}
          onSwitchToAgent={(ctx) => { setShowDailyCheckin(false); setPendingAgentContext(ctx); setTimeout(() => setView('agent'), 100); }} />
      )}
      {showDailyQuestion && (
        <DailyQuestion memberId={currentUser?.id} isAdmin={isAdmin} adminDeviceId={currentUser?.deviceId}
          onClose={() => setShowDailyQuestion(false)}
          onSwitchToAgent={(ctx) => { setShowDailyQuestion(false); setPendingAgentContext(ctx); setTimeout(() => setView('agent'), 100); }} />
      )}
      {showWeeklyNote && (
        <WeeklyNote memberId={currentUser?.id} onClose={() => setShowWeeklyNote(false)}
          onSwitchToAgent={(ctx) => { setShowWeeklyNote(false); setPendingAgentContext(ctx); setTimeout(() => setView('agent'), 100); }} />
      )}
      {showAdminCheckin && (
        <AdminCheckin memberId={currentUser?.id} members={members} onClose={() => setShowAdminCheckin(false)} />
      )}
      {showReportModal && (
        <DailyReportModal onClose={() => setShowReportModal(false)} />
      )}
      {showCalendar && (
        <div className="fixed inset-0 z-[9999] flex items-start justify-center pt-16 bg-black bg-opacity-50" onClick={() => setShowCalendar(false)}>
          <div className="w-full max-w-lg mx-4" onClick={e => e.stopPropagation()}>
            <ScheduleCalendar
              memberId={currentUser?.id}
              isAdmin={isAdmin}
              members={members}
            />
            <button
              onClick={() => setShowCalendar(false)}
              className="mt-3 w-full py-2 bg-gray-200 text-gray-600 rounded-lg text-sm font-medium"
            >
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
