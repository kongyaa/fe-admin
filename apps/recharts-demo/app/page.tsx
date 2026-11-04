'use client';

import { useState, useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  BarChart,
  Bar,
  PieChart,
  Pie,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import { ko } from 'date-fns/locale';

interface ChartData {
  name: string;
  orders: number;
  refunds: number;
  exchanges: number;
  date: string;
  day: string;
}

interface PieChartData {
  name: string;
  value: number;
}

type TimeFilter = 'day' | 'week' | 'month';

// 60일치 데이터 생성 함수
const generateDailyData = () => {
  const data: ChartData[] = [];
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const baseDate = new Date('2024-01-01');

  for (let i = 0; i < 60; i++) {
    const currentDate = new Date(baseDate);
    currentDate.setDate(baseDate.getDate() + i);

    // 주말에는 주문량이 약간 감소하도록 설정
    const isWeekend = currentDate.getDay() === 0 || currentDate.getDay() === 6;
    const orderBase = isWeekend ? 80 : 100;

    // 기본 주문량에 랜덤 변동성 추가
    const orders = Math.floor(orderBase + (Math.random() - 0.5) * 40);
    // 환불은 주문의 5-15% 정도
    const refunds = Math.floor(orders * (0.05 + Math.random() * 0.1));
    // 교환은 주문의 3-8% 정도
    const exchanges = Math.floor(orders * (0.03 + Math.random() * 0.05));

    data.push({
      name: currentDate.toISOString().split('T')[0],
      orders,
      refunds,
      exchanges,
      date: currentDate.toISOString().split('T')[0],
      day: days[currentDate.getDay()],
    });
  }
  return data;
};

const rawData: ChartData[] = generateDailyData();

const pieData: PieChartData[] = [
  {
    name: '정상 주문',
    value: rawData.reduce((sum, item) => sum + item.orders, 0),
  },
  { name: '환불', value: rawData.reduce((sum, item) => sum + item.refunds, 0) },
  {
    name: '교환',
    value: rawData.reduce((sum, item) => sum + item.exchanges, 0),
  },
];

export default function Home() {
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('day');
  const [startDate, setStartDate] = useState<Date>(new Date('2024-01-01'));
  const [endDate, setEndDate] = useState<Date>(new Date('2024-02-29'));

  const filteredData = useMemo(() => {
    return rawData.filter((item) => {
      const itemDate = new Date(item.date);
      return itemDate >= startDate && itemDate <= endDate;
    });
  }, [startDate, endDate]);

  const groupedData = useMemo(() => {
    if (timeFilter === 'day') {
      return filteredData;
    } else if (timeFilter === 'week') {
      // 주간 데이터 그룹화
      const weekData = filteredData.reduce((acc, curr) => {
        const weekNum = `${new Date(curr.date).getMonth() + 1}월 ${Math.ceil(
          new Date(curr.date).getDate() / 7,
        )}주차`;
        const existingWeek = acc.find((item) => item.name === weekNum);

        if (existingWeek) {
          existingWeek.orders += curr.orders;
          existingWeek.refunds += curr.refunds;
          existingWeek.exchanges += curr.exchanges;
        } else {
          acc.push({
            name: weekNum,
            orders: curr.orders,
            refunds: curr.refunds,
            exchanges: curr.exchanges,
            date: curr.date,
            day: weekNum,
          });
        }
        return acc;
      }, [] as ChartData[]);
      return weekData;
    } else {
      // 요일별 데이터 그룹화
      const dayData = filteredData.reduce((acc, curr) => {
        const existingDay = acc.find((item) => item.day === curr.day);

        if (existingDay) {
          existingDay.orders += curr.orders;
          existingDay.refunds += curr.refunds;
          existingDay.exchanges += curr.exchanges;
        } else {
          acc.push({
            name: curr.day,
            orders: curr.orders,
            refunds: curr.refunds,
            exchanges: curr.exchanges,
            date: curr.date,
            day: curr.day,
          });
        }
        return acc;
      }, [] as ChartData[]);

      // 요일 순서 정렬 (월요일부터 시작)
      const dayOrder = ['월', '화', '수', '목', '금', '토', '일'];
      return dayData.sort(
        (a, b) => dayOrder.indexOf(a.day) - dayOrder.indexOf(b.day),
      );
    }
  }, [timeFilter, filteredData]);

  // 차트 너비 계산
  const chartWidth = useMemo(() => {
    if (timeFilter === 'day') {
      // 일별 데이터일 때 데이터 개수에 따라 너비 조정
      const dataCount = groupedData.length;
      // 데이터 하나당 최소 60px 할당
      return Math.max(dataCount * 60, 800);
    }
    return 800; // 기본 너비
  }, [timeFilter, groupedData]);

  return (
    <main className="flex min-h-screen flex-col items-center p-24">
      <h1 className="text-4xl font-bold mb-8">주문 현황 대시보드</h1>

      <div className="w-full max-w-4xl space-y-8">
        <div className="p-6 bg-white rounded-lg shadow-lg">
          <div className="flex flex-col space-y-4 mb-6">
            <div className="flex justify-between items-center">
              <h2 className="text-2xl font-semibold">주문/환불/교환 추이</h2>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-gray-600">조회기간:</span>
                  <DatePicker
                    selected={startDate}
                    onChange={(date) => setStartDate(date || new Date())}
                    selectsStart
                    startDate={startDate}
                    endDate={endDate}
                    dateFormat="yyyy-MM-dd"
                    locale={ko}
                    className="px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <span>~</span>
                  <DatePicker
                    selected={endDate}
                    onChange={(date) => setEndDate(date || new Date())}
                    selectsEnd
                    startDate={startDate}
                    endDate={endDate}
                    minDate={startDate}
                    dateFormat="yyyy-MM-dd"
                    locale={ko}
                    className="px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setTimeFilter('day')}
                className={`px-4 py-2 rounded-lg ${
                  timeFilter === 'day'
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 text-gray-700'
                }`}
              >
                일별
              </button>
              <button
                onClick={() => setTimeFilter('week')}
                className={`px-4 py-2 rounded-lg ${
                  timeFilter === 'week'
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 text-gray-700'
                }`}
              >
                주별
              </button>
              <button
                onClick={() => setTimeFilter('month')}
                className={`px-4 py-2 rounded-lg ${
                  timeFilter === 'month'
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 text-gray-700'
                }`}
              >
                요일별
              </button>
            </div>
          </div>
          <div className={`${timeFilter === 'day' ? 'overflow-x-auto' : ''}`}>
            <div
              style={{
                width: timeFilter === 'day' ? `${chartWidth}px` : '100%',
                minWidth: '100%',
              }}
            >
              <ResponsiveContainer width="100%" height={400}>
                {timeFilter === 'week' ? (
                  <LineChart data={groupedData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="name"
                      angle={-45}
                      textAnchor="end"
                      height={60}
                    />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="orders"
                      stroke="#8884d8"
                      name="주문"
                      strokeWidth={2}
                    />
                    <Line
                      type="monotone"
                      dataKey="refunds"
                      stroke="#ff6b6b"
                      name="환불"
                      strokeWidth={2}
                    />
                    <Line
                      type="monotone"
                      dataKey="exchanges"
                      stroke="#82ca9d"
                      name="교환"
                      strokeWidth={2}
                    />
                  </LineChart>
                ) : (
                  <BarChart
                    data={groupedData}
                    barSize={timeFilter === 'day' ? 30 : 20}
                    barGap={timeFilter === 'day' ? 5 : 3}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="name"
                      angle={timeFilter === 'day' ? -45 : 0}
                      textAnchor={timeFilter === 'day' ? 'end' : 'middle'}
                      height={timeFilter === 'day' ? 60 : 30}
                      interval={timeFilter === 'day' ? 0 : 'preserveStartEnd'}
                    />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Bar
                      dataKey="orders"
                      fill="#8884d8"
                      name="주문"
                      radius={[4, 4, 0, 0]}
                    />
                    <Bar
                      dataKey="refunds"
                      fill="#ff6b6b"
                      name="환불"
                      radius={[4, 4, 0, 0]}
                    />
                    <Bar
                      dataKey="exchanges"
                      fill="#82ca9d"
                      name="교환"
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                )}
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        <div className="p-6 bg-white rounded-lg shadow-lg">
          <h2 className="text-2xl font-semibold mb-4">총 주문 처리 현황</h2>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={pieData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={100}
                fill="#8884d8"
                label
              >
                {pieData.map((entry, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={
                      index === 0
                        ? '#8884d8'
                        : index === 1
                          ? '#ff6b6b'
                          : '#82ca9d'
                    }
                  />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
    </main>
  );
}
