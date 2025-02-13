import Image from 'next/image';
import styles from './page.module.css';

const Home = (): React.ReactElement => {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <Image
          className={styles.logo}
          src="/next.svg"
          alt="Next.js Logo"
          width={180}
          height={37}
          priority
        />
      </main>
    </div>
  );
};

export default Home;
